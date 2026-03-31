// src/lib/review.ts

import { collectDiff } from "./diff.js";
import { assembleUserMessage, assembleChunkMessage, assembleFileManifest, assembleReduceMessage, extractHunkRanges, getReduceSystemPrompt } from "./prompt.js";
import { format } from "./formatter.js";
import { splitDiffByFile, binPackFiles } from "./chunking.js";
import { truncateForReduce } from "./truncation.js";
import {
  ClientError,
  ConfigError,
  DiffError,
  ReviewError,
  type ChatRequest,
  type ChunkedReviewResult,
  type DiffResult,
  type ModelInfo,
  type ReviewOptions,
  type ReviewResult,
  type ReviewStreamResult,
} from "./types.js";
import type { ReviewProvider } from "./providers/types.js";

/**
 * Decide whether to use the map-reduce chunked pipeline.
 */
export function shouldChunk(
  config: import("./types.js").ResolvedConfig,
  diff: DiffResult,
  modelInfo: ModelInfo,
): boolean {
  if (config.chunking === "always") return true;
  if (config.chunking === "never") return false;
  // "auto": chunk if estimated tokens >= 80% of model context
  const estimate = (config.prompt.length + diff.raw.length) / 4;
  return estimate >= modelInfo.maxPromptTokens * 0.8;
}

/**
 * Buffered review pipeline.
 * Routes to chunkedReview when shouldChunk() returns true.
 */
export async function review(
  options: ReviewOptions,
  provider: ReviewProvider,
): Promise<ReviewResult> {
  // Step 1: Collect diff
  let diff: DiffResult;
  try {
    diff = await collectDiffWithIgnorePaths(options);
  } catch (err) {
    if (err instanceof DiffError && err.code === "empty_diff") {
      return {
        content: "No changes found.",
        model: "none",
        usage: { totalTokens: 0 },
        diff: { raw: "", files: [], stats: { filesChanged: 0, insertions: 0, deletions: 0 } },
        warnings: [],
      };
    }
    throw err;
  }

  // Step 2: Resolve model
  const modelInfo = await resolveModel(options, provider);

  // Step 3: Route to chunked or single-pass
  const warnings: string[] = [];

  if (shouldChunk(options.config, diff, modelInfo)) {
    return chunkedReview(diff, modelInfo, options, provider, warnings);
  }

  // Single-pass: check token budget (throws if >= 100%)
  checkTokenBudget(options.config.prompt, diff, modelInfo, warnings);
  return singlePassReview(diff, modelInfo, options, provider, warnings);
}

/**
 * Single-pass review pipeline (renamed from old review() body).
 */
async function singlePassReview(
  diff: DiffResult,
  modelInfo: ModelInfo,
  options: ReviewOptions,
  provider: ReviewProvider,
  warnings: string[],
): Promise<ReviewResult> {
  // Assemble messages
  const userMessage = assembleUserMessage(diff);
  const request: ChatRequest = {
    model: modelInfo.id,
    systemPrompt: options.config.prompt,
    messages: [{ role: "user", content: userMessage }],
    stream: false,
  };

  // Call API
  const chatResponse = await provider.chat(request);

  // Handle empty response
  if (!chatResponse.content) {
    warnings.push("Provider returned no findings.");
  }

  const reviewResult: ReviewResult = {
    content: chatResponse.content || "",
    model: chatResponse.model,
    usage: chatResponse.usage,
    diff,
    warnings,
  };

  const formatted = format(reviewResult, options.config.format);

  return {
    content: formatted,
    model: chatResponse.model,
    usage: chatResponse.usage,
    diff,
    warnings,
  };
}

/**
 * Map-reduce chunked review pipeline.
 *
 * 1. Split diff by file
 * 2. Bin-pack into chunks
 * 3. MAP: review each chunk sequentially
 * 4. REDUCE: aggregate findings (skip if only 1 chunk)
 * 5. Return ChunkedReviewResult with metadata
 */
async function chunkedReview(
  diff: DiffResult,
  modelInfo: ModelInfo,
  options: ReviewOptions,
  provider: ReviewProvider,
  warnings: string[],
): Promise<ReviewResult> {
  // Split diff into per-file segments
  const { segments, warnings: splitWarnings } = splitDiffByFile(diff.raw);
  warnings.push(...splitWarnings);

  // Compute chunk budget: model context minus system prompt overhead
  const chunkBudget = modelInfo.maxPromptTokens - Math.floor(options.config.prompt.length / 4) - 150;
  if (chunkBudget <= 0) {
    throw new ReviewError(
      "invalid_model_limits",
      `System prompt too large for model context (${modelInfo.id}). Reduce prompt size.`,
      false,
    );
  }

  // Bin-pack segments into chunks
  const chunks = binPackFiles(segments, chunkBudget);
  const totalChunks = chunks.length;

  // Build file manifest and hunk ranges for the whole diff
  const hunkRanges = extractHunkRanges(segments);

  // -------------------------------------------------------------------------
  // MAP phase
  // -------------------------------------------------------------------------

  const chunkFindings: { files: string[]; content: string; usage: { totalTokens: number } }[] = [];

  for (let i = 0; i < totalChunks; i++) {
    const chunkSegments = chunks[i];
    const chunkFiles = [...new Set(chunkSegments.map((s) => s.path))];

    const makeRequest = (segs: typeof chunkSegments, chunkIdx: number, chunkOf: number): ChatRequest => {
      const segPaths = new Set(segs.map((s) => s.path));
      const chunkFileChanges = diff.files.filter((f) => segPaths.has(f.path));
      const chunkHunkRanges = extractHunkRanges(segs);
      const fileManifest = assembleFileManifest(chunkFileChanges, chunkHunkRanges);
      return {
        model: modelInfo.id,
        systemPrompt: options.config.prompt,
        messages: [{ role: "user", content: assembleChunkMessage(chunkIdx, chunkOf, segs, fileManifest) }],
        stream: false,
      };
    };

    let response;
    try {
      response = await provider.chat(makeRequest(chunkSegments, i, totalChunks));
    } catch (err) {
      if (err instanceof ClientError && isContextLengthError(err)) {
        // Re-bin the chunk's files into sub-chunks with reduced budget
        const reducedBudget = Math.floor(chunkBudget * 0.8);
        const subChunks = binPackFiles(chunkSegments, reducedBudget);

        for (let j = 0; j < subChunks.length; j++) {
          const subSegs = subChunks[j];
          const subFiles = subSegs.map((s) => s.path);
          let subResponse;
          try {
            subResponse = await provider.chat(makeRequest(subSegs, j, subChunks.length));
          } catch (retryErr) {
            throw new ReviewError(
              "chunk_failed",
              `Review failed on chunk ${i + 1}/${totalChunks} (sub-chunk ${j + 1}/${subChunks.length}) (${subFiles.join(", ")}): ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
              false,
              retryErr instanceof Error ? retryErr : undefined,
            );
          }

          if (process.env.LLM_REVIEWER_PROGRESS !== "0") {
            const tokenStr = subResponse.usage?.totalTokens ?? 0;
            process.stderr.write(
              `Reviewing chunk ${i + 1}/${totalChunks} sub-chunk ${j + 1}/${subChunks.length} (${subFiles.join(", ")})... done (${tokenStr} tokens)\n`,
            );
          }

          chunkFindings.push({
            files: subFiles,
            content: subResponse.content || "",
            usage: subResponse.usage ?? { totalTokens: 0 },
          });
        }
        // Sub-chunks already pushed — skip the normal push below
        continue;
      } else {
        throw new ReviewError(
          "chunk_failed",
          `Review failed on chunk ${i + 1}/${totalChunks} (${chunkFiles.join(", ")}): ${err instanceof Error ? err.message : String(err)}`,
          false,
          err instanceof Error ? err : undefined,
        );
      }
    }

    if (process.env.LLM_REVIEWER_PROGRESS !== "0") {
      const tokenStr = response.usage?.totalTokens ?? 0;
      process.stderr.write(
        `Reviewing chunk ${i + 1}/${totalChunks} (${chunkFiles.join(", ")})... done (${tokenStr} tokens)\n`,
      );
    }

    chunkFindings.push({
      files: chunkFiles,
      content: response.content || "",
      usage: response.usage ?? { totalTokens: 0 },
    });
  }

  // -------------------------------------------------------------------------
  // If only 1 chunk — skip reduce
  // -------------------------------------------------------------------------

  if (totalChunks === 1) {
    const singleFinding = chunkFindings[0];
    const chunkUsage = singleFinding.usage;

    const baseResult: ReviewResult = {
      content: singleFinding.content,
      model: modelInfo.id,
      usage: chunkUsage,
      diff,
      warnings,
    };
    const formatted = format(baseResult, options.config.format);

    const result: ChunkedReviewResult = {
      content: formatted,
      model: modelInfo.id,
      usage: chunkUsage,
      diff,
      warnings,
      chunked: true,
      chunks: [{ files: singleFinding.files, usage: chunkUsage }],
      reduceUsage: { totalTokens: 0 },
    };
    return result;
  }

  // -------------------------------------------------------------------------
  // REDUCE phase
  // -------------------------------------------------------------------------

  const reduceBudget = Math.floor(modelInfo.maxPromptTokens * 0.9);

  // Check if findings fit in reduce budget; truncate if needed
  const rawFindings = chunkFindings.map((f) => f.content);
  const totalFindingTokens = rawFindings.reduce((sum, f) => sum + Math.ceil(f.length / 4), 0);

  let truncationPreamble = "";
  let finalFindings = rawFindings;

  if (totalFindingTokens > reduceBudget) {
    const { truncated, warnings: truncWarnings, didTruncate } = truncateForReduce(rawFindings, reduceBudget);
    finalFindings = truncated;
    warnings.push(...truncWarnings);
    if (didTruncate) {
      truncationPreamble = "Note: some chunk findings were truncated to fit model context.\n\n";
    }
  }

  const chunkFindingsForReduce = chunkFindings.map((f, i) => ({
    files: f.files,
    content: finalFindings[i],
  }));

  const reduceMessageBody = assembleReduceMessage(chunkFindingsForReduce, diff.files, hunkRanges);
  const reduceMessage = truncationPreamble + reduceMessageBody;

  let reduceContent: string;
  let reduceUsage: { totalTokens: number };

  try {
    const reduceRequest: ChatRequest = {
      model: modelInfo.id,
      systemPrompt: getReduceSystemPrompt(),
      messages: [{ role: "user", content: reduceMessage }],
      stream: false,
    };
    const reduceResponse = await provider.chat(reduceRequest);
    reduceContent = reduceResponse.content || "";
    reduceUsage = reduceResponse.usage ?? { totalTokens: 0 };
  } catch (err) {
    // Fallback: concatenate raw chunk findings
    warnings.push(
      `Reduce pass failed: ${err instanceof Error ? err.message : String(err)}. Falling back to raw per-chunk findings.`,
    );
    reduceContent =
      "⚠ Aggregation failed — raw per-chunk findings below (may contain duplicates):\n\n" +
      chunkFindings.map((f, i) => `## Chunk ${i + 1} (${f.files.join(", ")})\n${f.content}`).join("\n\n");
    reduceUsage = { totalTokens: 0 };
  }

  // Sum all token usage
  const totalTokens =
    chunkFindings.reduce((sum, f) => sum + f.usage.totalTokens, 0) + reduceUsage.totalTokens;

  const baseResult: ReviewResult = {
    content: reduceContent,
    model: modelInfo.id,
    usage: { totalTokens },
    diff,
    warnings,
  };
  const formatted = format(baseResult, options.config.format);

  const result: ChunkedReviewResult = {
    content: formatted,
    model: modelInfo.id,
    usage: { totalTokens },
    diff,
    warnings,
    chunked: true,
    chunks: chunkFindings.map((f) => ({ files: f.files, usage: f.usage })),
    reduceUsage,
  };
  return result;
}

/**
 * Streaming review pipeline.
 * Routes to chunkedReviewStream when shouldChunk() returns true.
 * Otherwise streams directly via provider.chatStream().
 */
export async function reviewStream(
  options: ReviewOptions,
  provider: ReviewProvider,
): Promise<ReviewStreamResult> {
  // Step 1: Collect diff (throws on empty — no early return for streaming)
  const diff = await collectDiffWithIgnorePaths(options);

  // Step 2: Resolve model
  const modelInfo = await resolveModel(options, provider);

  // Step 3: Route — chunked streaming or single-pass streaming
  const warnings: string[] = [];

  if (shouldChunk(options.config, diff, modelInfo)) {
    return chunkedReviewStream(diff, modelInfo, options, provider, warnings);
  }

  // Only check token budget for single-pass (chunking handles oversized diffs)
  checkTokenBudget(options.config.prompt, diff, modelInfo, warnings);
  return singlePassStream(diff, modelInfo, options, provider, warnings);
}

/**
 * Single-pass streaming pipeline (direct chatStream, no chunking).
 */
async function singlePassStream(
  diff: DiffResult,
  modelInfo: ModelInfo,
  options: ReviewOptions,
  provider: ReviewProvider,
  warnings: string[],
): Promise<ReviewStreamResult> {
  const userMessage = assembleUserMessage(diff);
  const request: ChatRequest = {
    model: modelInfo.id,
    systemPrompt: options.config.prompt,
    messages: [{ role: "user", content: userMessage }],
    stream: true,
  };

  const rawStream = provider.chatStream(request);
  const usageCapture: { value?: { totalTokens: number } } = {};

  async function* textStream(): AsyncIterable<string> {
    for await (const chunk of rawStream) {
      if ((chunk.type === "content" || chunk.type === "reasoning") && chunk.text) {
        yield chunk.text;
      }
      if (chunk.type === "done" && chunk.usage) {
        usageCapture.value = chunk.usage;
      }
    }
  }

  return {
    stream: textStream(),
    warnings,
    diff,
    model: modelInfo.id,
    get usage() { return usageCapture.value; },
  };
}

/**
 * Chunked streaming pipeline: buffered MAP phase + streamed REDUCE phase.
 *
 * - MAP: provider.chat() per chunk (buffered, not user-facing)
 * - Single chunk: provider.chatStream() directly (no reduce)
 * - REDUCE (>1 chunk): provider.chatStream() — streams final output to caller
 */
async function chunkedReviewStream(
  diff: DiffResult,
  modelInfo: ModelInfo,
  options: ReviewOptions,
  provider: ReviewProvider,
  warnings: string[],
): Promise<ReviewStreamResult> {
  // Split diff into per-file segments
  const { segments, warnings: splitWarnings } = splitDiffByFile(diff.raw);
  warnings.push(...splitWarnings);

  // Compute chunk budget
  const chunkBudget = modelInfo.maxPromptTokens - Math.floor(options.config.prompt.length / 4) - 150;
  if (chunkBudget <= 0) {
    throw new ReviewError(
      "invalid_model_limits",
      `System prompt too large for model context (${modelInfo.id}). Reduce prompt size.`,
      false,
    );
  }

  const chunks = binPackFiles(segments, chunkBudget);
  const totalChunks = chunks.length;
  const hunkRanges = extractHunkRanges(segments);

  // -------------------------------------------------------------------------
  // Single chunk → stream directly, no reduce
  // -------------------------------------------------------------------------

  if (totalChunks === 1) {
    const [chunkSegments] = chunks;
    const singleChunkFileChanges = diff.files.filter((f) => chunkSegments.some((s) => s.path === f.path));
    const singleChunkHunkRanges = extractHunkRanges(chunkSegments);
    const singleChunkManifest = assembleFileManifest(singleChunkFileChanges, singleChunkHunkRanges);
    const request: ChatRequest = {
      model: modelInfo.id,
      systemPrompt: options.config.prompt,
      messages: [{ role: "user", content: assembleChunkMessage(0, 1, chunkSegments, singleChunkManifest) }],
      stream: true,
    };

    const rawStream = provider.chatStream(request);
    const usageCapture: { value?: { totalTokens: number } } = {};

    async function* textStream(): AsyncIterable<string> {
      for await (const chunk of rawStream) {
        if ((chunk.type === "content" || chunk.type === "reasoning") && chunk.text) {
          yield chunk.text;
        }
        if (chunk.type === "done" && chunk.usage) {
          usageCapture.value = chunk.usage;
        }
      }
    }

    return {
      stream: textStream(),
      warnings,
      diff,
      model: modelInfo.id,
      get usage() { return usageCapture.value; },
    };
  }

  // -------------------------------------------------------------------------
  // MAP phase (buffered) — >1 chunk
  // -------------------------------------------------------------------------

  const chunkFindings: { files: string[]; content: string; usage: { totalTokens: number } }[] = [];

  for (let i = 0; i < totalChunks; i++) {
    const chunkSegments = chunks[i];
    const chunkFiles = [...new Set(chunkSegments.map((s) => s.path))];

    const chunkSegPaths = new Set(chunkSegments.map((s) => s.path));
    const chunkFileChanges = diff.files.filter((f) => chunkSegPaths.has(f.path));
    const chunkHunkRanges = extractHunkRanges(chunkSegments);
    const chunkManifest = assembleFileManifest(chunkFileChanges, chunkHunkRanges);

    let response;
    try {
      response = await provider.chat({
        model: modelInfo.id,
        systemPrompt: options.config.prompt,
        messages: [{ role: "user", content: assembleChunkMessage(i, totalChunks, chunkSegments, chunkManifest) }],
        stream: false,
      });
    } catch (err) {
      throw new ReviewError(
        "chunk_failed",
        `Review failed on chunk ${i + 1}/${totalChunks} (${chunkFiles.join(", ")}): ${err instanceof Error ? err.message : String(err)}`,
        false,
        err instanceof Error ? err : undefined,
      );
    }

    if (process.env.LLM_REVIEWER_PROGRESS !== "0") {
      const tokenStr = response.usage?.totalTokens ?? 0;
      process.stderr.write(
        `Reviewing chunk ${i + 1}/${totalChunks} (${chunkFiles.join(", ")})... done (${tokenStr} tokens)\n`,
      );
    }

    chunkFindings.push({
      files: chunkFiles,
      content: response.content || "",
      usage: response.usage ?? { totalTokens: 0 },
    });
  }

  // -------------------------------------------------------------------------
  // REDUCE phase (streamed)
  // -------------------------------------------------------------------------

  const reduceBudget = Math.floor(modelInfo.maxPromptTokens * 0.9);
  const rawFindings = chunkFindings.map((f) => f.content);
  const totalFindingTokens = rawFindings.reduce((sum, f) => sum + Math.ceil(f.length / 4), 0);

  let truncationPreamble = "";
  let finalFindings = rawFindings;

  if (totalFindingTokens > reduceBudget) {
    const { truncated, warnings: truncWarnings, didTruncate } = truncateForReduce(rawFindings, reduceBudget);
    finalFindings = truncated;
    warnings.push(...truncWarnings);
    if (didTruncate) {
      truncationPreamble = "Note: some chunk findings were truncated to fit model context.\n\n";
    }
  }

  const chunkFindingsForReduce = chunkFindings.map((f, i) => ({
    files: f.files,
    content: finalFindings[i],
  }));

  const reduceMessageBody = assembleReduceMessage(chunkFindingsForReduce, diff.files, hunkRanges);
  const reduceMessage = truncationPreamble + reduceMessageBody;

  if (process.env.LLM_REVIEWER_PROGRESS !== "0") {
    process.stderr.write("Aggregating findings...\n");
  }

  const reduceRequest: ChatRequest = {
    model: modelInfo.id,
    systemPrompt: getReduceSystemPrompt(),
    messages: [{ role: "user", content: reduceMessage }],
    stream: true,
  };

  const rawStream = provider.chatStream(reduceRequest);
  const usageCapture: { value?: { totalTokens: number } } = {};
  const mapTokens = chunkFindings.reduce((sum, f) => sum + f.usage.totalTokens, 0);

  async function* textStream(): AsyncIterable<string> {
    for await (const chunk of rawStream) {
      if ((chunk.type === "content" || chunk.type === "reasoning") && chunk.text) {
        yield chunk.text;
      }
      if (chunk.type === "done" && chunk.usage) {
        usageCapture.value = { totalTokens: mapTokens + chunk.usage.totalTokens };
      }
    }
  }

  return {
    stream: textStream(),
    warnings,
    diff,
    model: modelInfo.id,
    get usage() { return usageCapture.value; },
  };
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Returns true if the error looks like a context-length / payload-too-large error
 * from the upstream API.
 */
function isContextLengthError(err: ClientError): boolean {
  const code = err.code ?? "";
  const msg = err.message ?? "";
  if (code === "context_length_exceeded" || code === "payload_too_large") return true;
  if (err.status === 413) return true;
  return /context.{0,20}length|too.{0,10}long|payload.{0,10}large/i.test(msg);
}

/**
 * Collect diff with ignorePaths merged from config into DiffOptions.
 */
async function collectDiffWithIgnorePaths(options: ReviewOptions): Promise<DiffResult> {
  const diffOptions = {
    ...options.diff,
    ignorePaths: options.config.ignorePaths,
  };
  return collectDiff(diffOptions);
}

/**
 * Resolve model: auto-select or explicit validation.
 * If provider has no autoSelect and model is "auto", throws ConfigError.
 */
async function resolveModel(
  options: ReviewOptions,
  provider: ReviewProvider,
): Promise<ModelInfo> {
  const rawModelId = options.model ?? options.config.model;
  const modelId = rawModelId?.trim() ?? null;

  if (modelId == null || modelId === "" || modelId === "auto") {
    if (!provider.autoSelect) {
      throw new ConfigError(
        "model_required",
        `Provider '${provider.name}' requires an explicit model. Use --model or set model in config.`,
        "",
        true,
      );
    }
    const selectedId = await provider.autoSelect();
    return provider.validateModel(selectedId);
  }

  return provider.validateModel(modelId);
}

/**
 * Check token budget against model limits.
 * Mutates warnings array in-place.
 * Throws ReviewError if estimate >= 100% of maxPromptTokens.
 */
function checkTokenBudget(
  prompt: string,
  diff: DiffResult,
  modelInfo: ModelInfo,
  warnings: string[],
): void {
  const estimatedTokens = (prompt.length + diff.raw.length) / 4;
  const ratio = estimatedTokens / modelInfo.maxPromptTokens;

  if (ratio >= 1.0) {
    const error = new ReviewError(
      "diff_too_large",
      `diff_too_large: Estimated token usage (${Math.round(estimatedTokens)}) exceeds model limit (${modelInfo.maxPromptTokens}). Use ignorePaths or a larger-context model.`,
      false,
    );
    error.suggestion = "Use ignorePaths or a larger-context model";
    throw error;
  }

  if (ratio >= 0.8) {
    warnings.push(
      `Token budget warning: estimated ${Math.round(estimatedTokens)} tokens is ${Math.round(ratio * 100)}% of model limit (${modelInfo.maxPromptTokens}). Consider splitting the review or using a larger-context model.`,
    );
  }
}
