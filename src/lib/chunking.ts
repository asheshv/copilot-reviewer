// src/lib/chunking.ts
import { ReviewError } from "./types.js";

// ============================================================================
// Types
// ============================================================================

export interface FileSegment {
  path: string;
  raw: string;
  estimatedTokens: number; // Math.floor(raw.length / 4)
  hunks: HunkSegment[];
}

export interface HunkSegment {
  header: string;       // @@ -a,b +c,d @@ line
  raw: string;          // full hunk including header
  startLine: number;    // +c value from header
  estimatedTokens: number;
}

export interface SplitResult {
  segments: FileSegment[];
  warnings: string[];
}

// ============================================================================
// Hunk header parsing
// ============================================================================

/**
 * Parses a unified diff hunk header line.
 * Handles: @@ -a,b +c,d @@, @@ -a +c @@, @@ -0,0 +1,N @@, @@ -1,N +0,0 @@
 * Returns startLine (the +c value) or null if the header is malformed.
 */
function parseHunkHeader(line: string): number | null {
  // Match @@ -oldStart[,oldCount] +newStart[,newCount] @@
  const match = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
  if (!match) return null;
  return parseInt(match[1], 10);
}

// ============================================================================
// splitDiffByFile
// ============================================================================

/**
 * Splits a raw unified diff into per-file segments.
 *
 * - Parses by `diff --git a/ b/` boundaries
 * - Binary files: added to warnings, excluded from segments
 * - No `diff --git` boundary: returns single segment with path "unknown"
 * - Malformed hunk headers: content included in segment, warning added
 */
export function splitDiffByFile(rawDiff: string): SplitResult {
  const segments: FileSegment[] = [];
  const warnings: string[] = [];

  // Check for diff --git boundaries
  if (!rawDiff.includes("diff --git ")) {
    // Return the whole thing as a single "unknown" segment
    const raw = rawDiff;
    const hunks = parseHunks(raw, "unknown", warnings);
    segments.push({
      path: "unknown",
      raw,
      estimatedTokens: Math.floor(raw.length / 4),
      hunks,
    });
    return { segments, warnings };
  }

  // Split by diff --git boundaries (keep the delimiter at start of each section)
  const sections = rawDiff.split(/(?=diff --git )/);

  for (const section of sections) {
    if (!section.trim()) continue;

    // Extract path from "diff --git a/... b/..." line
    const diffLineMatch = section.match(/^diff --git a\/(.+?) b\/(.+?)$/m);
    if (!diffLineMatch) continue;

    const pathB = diffLineMatch[2];
    const path = pathB;

    // Skip binary files — add warning
    if (/^Binary files .* differ$/m.test(section)) {
      warnings.push(`Skipping binary file: ${path}`);
      continue;
    }

    const hunks = parseHunks(section, path, warnings);

    segments.push({
      path,
      raw: section,
      estimatedTokens: Math.floor(section.length / 4),
      hunks,
    });
  }

  return { segments, warnings };
}

/**
 * Parses hunk segments from a file diff section.
 * Adds to warnings if malformed hunk headers are found.
 */
function parseHunks(
  section: string,
  path: string,
  warnings: string[]
): HunkSegment[] {
  const hunks: HunkSegment[] = [];
  const lines = section.split("\n");

  let currentHunkLines: string[] = [];
  let currentHeader: string | null = null;
  let currentStartLine = 0;
  let hasHunkHeaders = false;
  let hasMalformed = false;

  const flushHunk = () => {
    if (currentHeader !== null && currentHunkLines.length > 0) {
      const raw = currentHunkLines.join("\n");
      hunks.push({
        header: currentHeader,
        raw,
        startLine: currentStartLine,
        estimatedTokens: Math.floor(raw.length / 4),
      });
    }
    currentHunkLines = [];
    currentHeader = null;
    currentStartLine = 0;
  };

  for (const line of lines) {
    if (line.startsWith("@@")) {
      // Try to parse as valid hunk header
      const startLine = parseHunkHeader(line);
      if (startLine !== null) {
        flushHunk();
        hasHunkHeaders = true;
        currentHeader = line;
        currentStartLine = startLine;
        currentHunkLines = [line];
      } else {
        // Malformed hunk header
        hasMalformed = true;
        if (currentHeader !== null) {
          currentHunkLines.push(line);
        }
        // If no current hunk started, just skip the malformed header line
        // (it will end up in the segment raw, but not a hunk)
      }
    } else if (currentHeader !== null) {
      currentHunkLines.push(line);
    }
  }

  flushHunk();

  if (hasMalformed && !hasHunkHeaders) {
    // All hunk headers were malformed — warn
    warnings.push(`Malformed hunk header(s) in ${path}`);
  } else if (hasMalformed) {
    warnings.push(`Malformed hunk header(s) in ${path}`);
  }

  return hunks;
}

// ============================================================================
// binPackFiles
// ============================================================================

/**
 * Bin-packs file segments into chunks using First-Fit Decreasing.
 *
 * - Sort by estimatedTokens desc, tie-break alphabetically by path
 * - fits formula: currentTokens + fileTokens + (10 * (filesInChunk + 1)) < chunkBudget
 * - If a file alone exceeds budget → split by hunks via splitFileByHunks
 *
 * @throws ReviewError("invalid_model_limits") if chunkBudget <= 0
 */
export function binPackFiles(
  segments: FileSegment[],
  chunkBudget: number
): FileSegment[][] {
  if (chunkBudget <= 0) {
    throw new ReviewError(
      "invalid_model_limits",
      `chunkBudget must be > 0, got ${chunkBudget}`,
      false
    );
  }

  // Sort: largest first, tie-break alphabetically
  const sorted = [...segments].sort((a, b) => {
    if (b.estimatedTokens !== a.estimatedTokens) {
      return b.estimatedTokens - a.estimatedTokens;
    }
    return a.path.localeCompare(b.path);
  });

  const chunks: FileSegment[][] = [];
  const chunkTokens: number[] = [];

  for (const seg of sorted) {
    // Check if segment fits into any existing chunk
    let placed = false;
    for (let i = 0; i < chunks.length; i++) {
      const filesInChunk = chunks[i].length;
      const overhead = 10 * (filesInChunk + 1);
      if (chunkTokens[i] + seg.estimatedTokens + overhead < chunkBudget) {
        chunks[i].push(seg);
        chunkTokens[i] += seg.estimatedTokens + 10;
        placed = true;
        break;
      }
    }

    if (!placed) {
      // Check if it fits alone
      const overheadAlone = 10 * 1;
      if (seg.estimatedTokens + overheadAlone < chunkBudget) {
        chunks.push([seg]);
        chunkTokens.push(seg.estimatedTokens + 10);
      } else {
        // File alone exceeds budget → split by hunks
        const hunkChunks = splitFileByHunks(seg, chunkBudget);
        for (const hunkChunk of hunkChunks) {
          const tokenSum = hunkChunk.reduce((s, f) => s + f.estimatedTokens, 0);
          chunks.push(hunkChunk);
          chunkTokens.push(tokenSum);
        }
      }
    }
  }

  return chunks;
}

// ============================================================================
// splitFileByHunks
// ============================================================================

/**
 * Splits a single file segment into chunks by hunk, bin-packed with FFD.
 *
 * - Zero hunks → treat entire segment as one hunk
 * - Single hunk exceeds budget → truncate with marker
 */
export function splitFileByHunks(
  segment: FileSegment,
  chunkBudget: number
): FileSegment[][] {
  // If no hunks, treat entire segment as a single synthetic hunk
  const hunks: HunkSegment[] =
    segment.hunks.length > 0
      ? segment.hunks
      : [
          {
            header: "",
            raw: segment.raw,
            startLine: 0,
            estimatedTokens: segment.estimatedTokens,
          },
        ];

  // Sort hunks by estimatedTokens desc
  const sorted = [...hunks].sort(
    (a, b) => b.estimatedTokens - a.estimatedTokens
  );

  const chunks: FileSegment[][] = [];
  const chunkTokens: number[] = [];

  for (const hunk of sorted) {
    let hunkToPlace = hunk;

    // Truncate if hunk alone exceeds budget
    const overheadAlone = 10;
    if (hunkToPlace.estimatedTokens + overheadAlone >= chunkBudget) {
      hunkToPlace = truncateHunk(hunkToPlace, chunkBudget);
    }

    // Try to fit into an existing chunk
    let placed = false;
    for (let i = 0; i < chunks.length; i++) {
      const filesInChunk = chunks[i].length;
      const overhead = 10 * (filesInChunk + 1);
      if (chunkTokens[i] + hunkToPlace.estimatedTokens + overhead < chunkBudget) {
        // Add hunk as a synthetic FileSegment into this chunk
        const hunkSeg = hunkToFileSegment(segment, hunkToPlace);
        chunks[i].push(hunkSeg);
        chunkTokens[i] += hunkToPlace.estimatedTokens + 10;
        placed = true;
        break;
      }
    }

    if (!placed) {
      const hunkSeg = hunkToFileSegment(segment, hunkToPlace);
      chunks.push([hunkSeg]);
      chunkTokens.push(hunkToPlace.estimatedTokens + 10);
    }
  }

  return chunks;
}

/**
 * Wraps a HunkSegment as a FileSegment (for returning from splitFileByHunks).
 */
function hunkToFileSegment(parent: FileSegment, hunk: HunkSegment): FileSegment {
  return {
    path: parent.path,
    raw: hunk.raw,
    estimatedTokens: hunk.estimatedTokens,
    hunks: [hunk],
  };
}

/**
 * Truncates a hunk's raw content to fit within chunkBudget tokens.
 * Snaps to nearest `\n` scanning backward; falls back to hard limit if no `\n`
 * within 1000 chars. Appends a truncation marker and preserves the @@ header.
 */
function truncateHunk(hunk: HunkSegment, chunkBudget: number): HunkSegment {
  const budgetTokens = chunkBudget - 10; // leave room for overhead
  const limitChars = budgetTokens * 4;
  const originalTokens = hunk.estimatedTokens;

  // Marker text (will be appended)
  const marker = `\n... [truncated — ${originalTokens} tokens reduced to ${budgetTokens} tokens. Full hunk too large for model context.]\n`;

  // We need the final string to be <= limitChars (approximately)
  // Reserve chars for the marker
  const contentLimit = Math.max(0, limitChars - marker.length);

  let truncated = hunk.raw.slice(0, contentLimit);

  // Snap to nearest \n scanning backward (within 1000 chars from end)
  const searchStart = Math.max(0, truncated.length - 1000);
  const lastNewline = truncated.lastIndexOf("\n", truncated.length - 1);

  if (lastNewline >= searchStart) {
    truncated = truncated.slice(0, lastNewline);
  }
  // else: no \n within 1000 chars, truncate at limit (truncated already is at contentLimit)

  const newRaw = truncated + marker;

  // Ensure header is preserved at the beginning
  const hasHeader = hunk.header && newRaw.startsWith(hunk.header);
  const finalRaw = hasHeader || !hunk.header ? newRaw : hunk.header + "\n" + newRaw;

  return {
    header: hunk.header,
    raw: finalRaw,
    startLine: hunk.startLine,
    estimatedTokens: Math.floor(finalRaw.length / 4),
  };
}
