// src/lib/prompt.ts
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import type { DiffResult, FileChange } from "./types.js";
import type { FileSegment } from "./chunking.js";

/**
 * Load the built-in default review prompt from prompts/default-review.md.
 * Uses import.meta.url to resolve the path relative to the package root.
 */
export function loadBuiltInPrompt(): string {
  // Get the directory of the current module
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = dirname(currentFile);

  // Navigate from src/lib to package root, then to prompts/
  const promptPath = join(currentDir, "..", "..", "prompts", "default-review.md");

  return readFileSync(promptPath, "utf-8");
}

// ============================================================================
// assembleFileManifest
// ============================================================================

/**
 * Returns a markdown table listing files, their status, and changed line ranges.
 * Three-column form (with hunk ranges) for chunk/reduce flows.
 *
 * - hunkRanges maps filePath → array of "startLine-endLine" strings.
 * - Deleted files always show "-" in Lines Changed regardless of hunkRanges.
 * - Files with no entry in hunkRanges show "-".
 */
export function assembleFileManifest(
  files: FileChange[],
  hunkRanges: Map<string, string[]>
): string {
  const rows = files.map((f) => {
    const linesChanged =
      f.status === "deleted"
        ? "-"
        : (hunkRanges.get(f.path) ?? []).join(", ") || "-";
    return `| ${f.path} | ${f.status} | ${linesChanged} |`;
  });

  return [
    "## Files Changed",
    "| File | Status | Lines Changed |",
    "|------|--------|---------------|",
    ...rows,
  ].join("\n");
}

/**
 * Returns a two-column markdown table (File, Status) for single-pass reviews
 * where hunk ranges are not available.
 */
function assembleSimpleFileManifest(files: FileChange[]): string {
  const rows = files.map((f) => `| ${f.path} | ${f.status} |`);
  return [
    "## Files Changed",
    "| File | Status |",
    "|------|--------|",
    ...rows,
  ].join("\n");
}

// ============================================================================
// extractHunkRanges
// ============================================================================

/**
 * Parses the new-file line count from a hunk header.
 * From "@@ -a,b +c,d @@", extracts d (defaults to 1 if omitted).
 */
function parseHunkLineCount(header: string): number {
  const match = header.match(/^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,(\d+))?\s+@@/);
  if (!match) return 1;
  // match[1] is the captured d value; undefined means count was omitted → 1
  return match[1] !== undefined ? parseInt(match[1], 10) : 1;
}

/**
 * Extracts line ranges from hunk segments across all file segments.
 * Returns Map<filePath, string[]> where each string is "startLine-endLine".
 * Files with zero hunks are omitted from the map.
 */
export function extractHunkRanges(segments: FileSegment[]): Map<string, string[]> {
  const result = new Map<string, string[]>();

  for (const seg of segments) {
    if (seg.hunks.length === 0) continue;

    const ranges: string[] = [];
    for (const hunk of seg.hunks) {
      const count = parseHunkLineCount(hunk.header);
      const startLine = hunk.startLine;
      const endLine = startLine + count - 1;
      ranges.push(`${startLine}-${endLine}`);
    }

    // Merge ranges for the same file (multiple segments can share a path when
    // splitFileByHunks produces hunk-level FileSegments)
    const existing = result.get(seg.path);
    if (existing) {
      existing.push(...ranges);
    } else {
      result.set(seg.path, ranges);
    }
  }

  return result;
}

// ============================================================================
// assembleChunkMessage
// ============================================================================

/**
 * Assembles the user message for a single chunk review pass.
 *
 * Format:
 *   Review chunk {i+1} of {n}.
 *   Files in this chunk: {comma-separated paths}
 *
 *   {fileManifest}
 *
 *   ```diff
 *   {joined raw diffs}
 *   ```
 */
export function assembleChunkMessage(
  chunkIndex: number,
  totalChunks: number,
  segments: FileSegment[],
  fileManifest: string
): string {
  const paths = segments.map((s) => s.path).join(", ");
  const rawDiff = segments.map((s) => s.raw).join("\n");

  return [
    `Review chunk ${chunkIndex + 1} of ${totalChunks}.`,
    `Files in this chunk: ${paths}`,
    "",
    fileManifest,
    "",
    "```diff",
    rawDiff,
    "```",
  ].join("\n");
}

// ============================================================================
// assembleReduceMessage
// ============================================================================

/**
 * Assembles the user message for the reduce (aggregation) pass.
 *
 * Format:
 *   The following are review findings from {n} review passes...
 *
 *   ## Chunk 1 (files: a.ts, b.ts)
 *   {findings}
 *
 *   ## Chunk 2 (files: c.ts)
 *   {findings}
 *
 *   ...
 *
 *   ## All files in this review (for cross-file analysis)
 *   {full file manifest}
 */
export function assembleReduceMessage(
  chunkFindings: { files: string[]; content: string }[],
  allFiles: FileChange[],
  allHunkRanges: Map<string, string[]>
): string {
  const n = chunkFindings.length;
  const lines: string[] = [
    `The following are review findings from ${n} review passes over different parts of a diff. Produce a single unified review.`,
    "",
  ];

  for (let i = 0; i < chunkFindings.length; i++) {
    const { files, content } = chunkFindings[i];
    lines.push(`## Chunk ${i + 1} (files: ${files.join(", ")})`);
    lines.push(content);
    lines.push("");
  }

  lines.push("## All files in this review (for cross-file analysis)");
  lines.push(assembleFileManifest(allFiles, allHunkRanges));

  return lines.join("\n");
}

// ============================================================================
// getReduceSystemPrompt
// ============================================================================

/**
 * Returns the hardcoded system prompt for the reduce (aggregation) pass.
 */
export function getReduceSystemPrompt(): string {
  return [
    "You are a code review aggregator. Deduplicate findings, reconcile severity, produce a unified review report.",
    "Flag any cross-file issues you can infer from the findings (e.g., API contract mismatches, inconsistent error handling).",
    "Only flag cross-file issues where evidence exists in the findings — do not speculate about files or code not shown.",
    "The full file list is provided at the end for context.",
  ].join("\n");
}

// ============================================================================
// assembleUserMessage
// ============================================================================

/**
 * Assemble the user message from a diff result.
 * Formats the summary stats, a simple files-changed table, and the raw diff.
 */
export function assembleUserMessage(diff: DiffResult): string {
  const { stats, raw, files } = diff;

  const message = [
    "Review the following changes.",
    "",
    "## Summary",
    `Files changed: ${stats.filesChanged}`,
    `Insertions: +${stats.insertions}, Deletions: -${stats.deletions}`,
    "",
    assembleSimpleFileManifest(files),
    "",
    "## Diff",
    "```diff",
    raw,
    "```",
  ].join("\n");

  return message;
}
