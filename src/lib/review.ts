// src/lib/review.ts

import { collectDiff } from "./diff.js";
import { assembleUserMessage } from "./prompt.js";
import { format } from "./formatter.js";
import {
  DiffError,
  ReviewError,
  type ChatRequest,
  type DiffResult,
  type ModelInfo,
  type ReviewOptions,
  type ReviewResult,
  type ReviewStreamResult,
} from "./types.js";
import type { CopilotClient } from "./client.js";
import type { ModelManager } from "./models.js";

/**
 * Buffered review pipeline.
 * Collects diff, resolves model, checks token budget, calls API, formats output.
 */
export async function review(
  options: ReviewOptions,
  client: CopilotClient,
  models: ModelManager,
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
  const modelInfo = await resolveModel(options, models);

  // Step 3: Check token budget
  const warnings: string[] = [];
  checkTokenBudget(options.config.prompt, diff, modelInfo, warnings);

  // Step 4: Assemble messages
  const userMessage = assembleUserMessage(diff);
  const request: ChatRequest = {
    model: modelInfo.id,
    systemPrompt: options.config.prompt,
    messages: [{ role: "user", content: userMessage }],
    stream: false,
  };

  // Step 5: Call API
  const useResponsesApi = modelInfo.endpoints.includes("/responses");
  const chatResponse = await client.chat(request, useResponsesApi);

  // Step 6: Handle empty response
  if (!chatResponse.content) {
    warnings.push("Copilot returned no findings.");
  }

  // Step 7: Format output (always, even for empty content — formatter adds structure)
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
 * Streaming review pipeline.
 * Same as buffered through steps 1-4, but returns an AsyncIterable<string> stream
 * instead of a formatted result.
 */
export async function reviewStream(
  options: ReviewOptions,
  client: CopilotClient,
  models: ModelManager,
): Promise<ReviewStreamResult> {
  // Step 1: Collect diff (throws on empty — no early return for streaming)
  const diff = await collectDiffWithIgnorePaths(options);

  // Step 2: Resolve model
  const modelInfo = await resolveModel(options, models);

  // Step 3: Check token budget
  const warnings: string[] = [];
  checkTokenBudget(options.config.prompt, diff, modelInfo, warnings);

  // Step 4: Assemble messages
  const userMessage = assembleUserMessage(diff);
  const request: ChatRequest = {
    model: modelInfo.id,
    systemPrompt: options.config.prompt,
    messages: [{ role: "user", content: userMessage }],
    stream: true,
  };

  // Step 5: Call streaming API
  const useResponsesApi = modelInfo.endpoints.includes("/responses");
  const rawStream = client.chatStream(request, useResponsesApi);

  const result: ReviewStreamResult = {
    stream: undefined as unknown as AsyncIterable<string>, // set below
    warnings,
    diff,
    model: modelInfo.id,
  };

  // Convert StreamChunk to plain text strings, capturing usage from the "done" chunk
  async function* textStream(): AsyncIterable<string> {
    for await (const chunk of rawStream) {
      if ((chunk.type === "content" || chunk.type === "reasoning") && chunk.text) {
        yield chunk.text;
      }
      if (chunk.type === "done" && chunk.usage) {
        result.usage = chunk.usage;
      }
    }
  }

  result.stream = textStream();
  return result;
}

// ============================================================================
// Internal helpers
// ============================================================================

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
 */
async function resolveModel(
  options: ReviewOptions,
  models: ModelManager,
): Promise<ModelInfo> {
  const modelId = options.model ?? options.config.model;

  if (!modelId || modelId === "auto") {
    const selectedId = await models.autoSelect();
    return models.validateModel(selectedId);
  }

  return models.validateModel(modelId);
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
