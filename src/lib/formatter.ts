// src/lib/formatter.ts

import type { ReviewResult, ChunkedReviewResult, OutputFormat, StreamChunk } from "./types.js";

function isChunked(result: ReviewResult): result is ChunkedReviewResult {
  return "chunked" in result && result.chunked === true;
}

function isUnaggregated(content: string): boolean {
  return content.startsWith("⚠ Aggregation failed");
}

/**
 * Format review result according to the specified output format.
 */
export function format(result: ReviewResult, fmt: OutputFormat): string {
  switch (fmt) {
    case "markdown":
      return formatMarkdown(result);
    case "text":
      return formatText(result);
    case "json":
      return formatJson(result);
  }
}

/**
 * Detect if content contains HIGH severity patterns.
 * Used to determine exit code (1 if HIGH found, 0 otherwise).
 */
export function detectHighSeverity(content: string): boolean {
  return /### HIGH|\[HIGH\]/.test(content);
}

/**
 * Format a streaming chunk as NDJSON (single-line JSON + newline).
 */
export function formatNdjsonChunk(chunk: StreamChunk): string {
  return JSON.stringify(chunk) + "\n";
}

// ============================================================================
// Internal formatters
// ============================================================================

/**
 * Format as markdown with header, verbatim content, and footer.
 */
function formatMarkdown(result: ReviewResult): string {
  const { model, diff, content, usage } = result;
  const { filesChanged, insertions, deletions } = diff.stats;

  let chunkSuffix = "";
  if (isChunked(result)) {
    const unaggregated = isUnaggregated(content) ? " (unaggregated)" : "";
    chunkSuffix = ` | **Chunks:** ${result.chunks.length}${unaggregated}`;
  }

  const header = `# Copilot Code Review

**Model:** ${model} | **Files:** ${filesChanged} | **+${insertions} -${deletions}**${chunkSuffix}

## Findings

`;

  const footer = `

---
*Tokens used: ${formatNumber(usage.totalTokens)} | Model: ${model}*`;

  return header + content + footer;
}

/**
 * Format as plain text with markdown syntax stripped.
 */
function formatText(result: ReviewResult): string {
  const { model, diff, content, usage } = result;
  const { filesChanged, insertions, deletions } = diff.stats;

  let chunkSuffix = "";
  if (isChunked(result)) {
    const unaggregated = isUnaggregated(content) ? " (unaggregated)" : "";
    chunkSuffix = ` | Chunks: ${result.chunks.length}${unaggregated}`;
  }

  const header = `Copilot Code Review
Model: ${model} | Files: ${filesChanged} | +${insertions} -${deletions}${chunkSuffix}

`;

  const footer = `

Tokens used: ${formatNumber(usage.totalTokens)}`;

  const strippedContent = stripMarkdown(content);

  return header + strippedContent + footer;
}

/**
 * Format as JSON with nested structure and exit code.
 */
function formatJson(result: ReviewResult): string {
  const { content, model, usage, diff, warnings } = result;

  let usageOutput: Record<string, unknown> = { ...usage };
  if (isChunked(result)) {
    const mapTokens = result.chunks.reduce((sum, c) => sum + c.usage.totalTokens, 0);
    const reduceTokens = result.reduceUsage.totalTokens;
    usageOutput = {
      ...usage,
      chunkedBreakdown: { mapTokens, reduceTokens, chunks: result.chunks.length },
    };
  }

  const output = {
    review: {
      content,
      model,
      usage: usageOutput,
    },
    diff: {
      filesChanged: diff.stats.filesChanged,
      insertions: diff.stats.insertions,
      deletions: diff.stats.deletions,
      files: diff.files,
    },
    warnings,
    exitCode: detectHighSeverity(content) ? 1 : 0,
  };

  return JSON.stringify(output, null, 2);
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Strip markdown syntax from text:
 * - Headers (## text) -> plain text
 * - Code fences (```...```) -> 4-space indented blocks
 * - Bold (**text**) and italic (*text*) -> plain text
 * - Inline code (`text`) -> plain text
 */
function stripMarkdown(text: string): string {
  let result = text;

  // Strip headers: ## Header -> Header
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "$1");

  // Strip code fences: ```lang\ncode\n``` -> indented code
  result = result.replace(/```[\w]*\n([\s\S]*?)```/g, (match, code) => {
    return code
      .split("\n")
      .map((line: string) => (line ? "    " + line : ""))
      .join("\n");
  });

  // Strip bold: **text** -> text
  result = result.replace(/\*\*(.+?)\*\*/g, "$1");

  // Strip italic: *text* -> text (but not * by itself)
  result = result.replace(/\*([^*\s].*?)\*/g, "$1");

  // Strip inline code: `text` -> text
  result = result.replace(/`(.+?)`/g, "$1");

  return result;
}

/**
 * Format number with comma thousands separators.
 */
function formatNumber(num: number): string {
  return num.toLocaleString("en-US");
}
