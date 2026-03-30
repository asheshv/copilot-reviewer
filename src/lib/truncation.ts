// src/lib/truncation.ts
// Pure functions — no provider imports, no side effects.

// ============================================================================
// Types
// ============================================================================

export interface SeverityTiers {
  high: string[];   // text blocks that are HIGH severity
  medium: string[]; // text blocks that are MEDIUM severity
  low: string[];    // text blocks that are LOW severity
}

export interface TruncationResult {
  truncated: string[];  // truncated findings per chunk (same length as input)
  warnings: string[];   // warning messages about what was truncated
  didTruncate: boolean;
}

// ============================================================================
// Internal helpers
// ============================================================================

type Severity = "HIGH" | "MEDIUM" | "LOW";

/**
 * Returns the severity level if a line is a start-of-line severity marker,
 * otherwise null.
 *
 * Recognised formats (case-insensitive, start of line only):
 *   ### HIGH / ### MEDIUM / ### LOW
 *   [HIGH] / [MEDIUM] / [LOW]
 *   **HIGH** / **MEDIUM** / **LOW**
 */
function lineMarkerSeverity(line: string): Severity | null {
  // Strip leading whitespace — but "start of line" means the marker must be the
  // very first non-whitespace content on the line (no preceding text content).
  const trimmed = line.trimStart();

  const mdHeader = /^###\s+(high|medium|low)\b/i;
  const bracketTag = /^\[(high|medium|low)\]/i;
  const boldTag = /^\*\*(high|medium|low)\*\*/i;

  let m: RegExpMatchArray | null;

  if ((m = trimmed.match(mdHeader)) !== null) {
    return m[1].toUpperCase() as Severity;
  }
  if ((m = trimmed.match(bracketTag)) !== null) {
    return m[1].toUpperCase() as Severity;
  }
  if ((m = trimmed.match(boldTag)) !== null) {
    return m[1].toUpperCase() as Severity;
  }

  return null;
}

/** Rough token estimate: characters / 4 */
function tokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Total token count across all chunks */
function totalTokens(chunks: string[]): number {
  return chunks.reduce((sum, c) => sum + tokenCount(c), 0);
}

// ============================================================================
// parseSeverityTiers
// ============================================================================

/**
 * Splits `text` into severity tiers based on start-of-line severity markers.
 *
 * - Content before the first marker → Tier 2 (MEDIUM).
 * - No markers found → entire text is Tier 2 (MEDIUM).
 * - Each block includes its leading marker line.
 */
export function parseSeverityTiers(text: string): SeverityTiers {
  const result: SeverityTiers = { high: [], medium: [], low: [] };

  const lines = text.split("\n");

  // Collect blocks: { severity, lines[] }
  type Block = { severity: Severity; lines: string[] };
  const blocks: Block[] = [];
  let currentBlock: Block | null = null;

  for (const line of lines) {
    const sev = lineMarkerSeverity(line);
    if (sev !== null) {
      // Start a new block
      if (currentBlock !== null) {
        blocks.push(currentBlock);
      }
      currentBlock = { severity: sev, lines: [line] };
    } else {
      if (currentBlock === null) {
        // Preamble content before first marker — treat as MEDIUM
        currentBlock = { severity: "MEDIUM", lines: [line] };
      } else {
        currentBlock.lines.push(line);
      }
    }
  }

  if (currentBlock !== null) {
    blocks.push(currentBlock);
  }

  // If no markers were found at all, the single block (if any) is already MEDIUM.
  // Edge case: if the text is empty, blocks is empty.
  if (blocks.length === 0) {
    // Empty text — return empty tiers
    return result;
  }

  // Merge consecutive blocks of the same severity that arose purely from preamble
  // (i.e., the preamble MEDIUM block and a later explicit MEDIUM block are separate items).
  for (const block of blocks) {
    const content = block.lines.join("\n");
    // Don't push empty-only blocks (e.g., trailing newline produces an empty string)
    if (content.trim() === "") continue;
    result[block.severity.toLowerCase() as keyof SeverityTiers].push(content);
  }

  return result;
}

// ============================================================================
// truncateForReduce — internal per-chunk operations
// ============================================================================

/**
 * Splits a chunk into its severity blocks with their tier labels.
 */
function splitChunkIntoBlocks(chunk: string): Array<{ severity: Severity; text: string }> {
  const lines = chunk.split("\n");
  const blocks: Array<{ severity: Severity; text: string }> = [];
  let currentSeverity: Severity = "MEDIUM"; // default for preamble
  let currentLines: string[] = [];
  let hasPreamble = false;

  for (const line of lines) {
    const sev = lineMarkerSeverity(line);
    if (sev !== null) {
      if (currentLines.length > 0) {
        blocks.push({ severity: currentSeverity, text: currentLines.join("\n") });
      }
      currentSeverity = sev;
      currentLines = [line];
      hasPreamble = true;
    } else {
      if (!hasPreamble && currentLines.length === 0 && line === "") {
        // skip leading empty lines before any content
        continue;
      }
      currentLines.push(line);
      hasPreamble = true;
    }
  }

  if (currentLines.length > 0) {
    blocks.push({ severity: currentSeverity, text: currentLines.join("\n") });
  }

  return blocks;
}

/**
 * Reassembles blocks back into a single chunk string.
 */
function joinBlocks(blocks: Array<{ severity: Severity; text: string }>): string {
  return blocks.map(b => b.text).join("\n");
}

// ---------------------------------------------------------------------------
// Round 1: Remove LOW blocks
// ---------------------------------------------------------------------------

function applyRound1(chunks: string[]): { chunks: string[]; lowOmitted: number; chunksAffected: number } {
  let lowOmitted = 0;
  let chunksAffected = 0;

  const result = chunks.map(chunk => {
    const blocks = splitChunkIntoBlocks(chunk);
    const lowBlocks = blocks.filter(b => b.severity === "LOW");
    if (lowBlocks.length === 0) return chunk;

    lowOmitted += lowBlocks.length;
    chunksAffected++;

    const kept = blocks.filter(b => b.severity !== "LOW");
    const placeholder = `[${lowBlocks.length} LOW findings omitted]`;
    kept.push({ severity: "LOW", text: placeholder });
    return joinBlocks(kept);
  });

  return { chunks: result, lowOmitted, chunksAffected };
}

// ---------------------------------------------------------------------------
// Round 2: Compress MEDIUM to title + first paragraph (drop Suggestion blocks)
// ---------------------------------------------------------------------------

function compressMediumToSummary(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let blankCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Stop at **Suggestion:** line
    if (/^\*\*Suggestion:\*\*/i.test(line)) {
      break;
    }

    if (line === "") {
      blankCount++;
      if (blankCount >= 2) {
        // Second blank line = end of first paragraph → stop
        break;
      }
      result.push(line);
    } else {
      blankCount = 0; // reset on non-blank line
      result.push(line);
    }
  }

  // Trim trailing blank lines
  while (result.length > 0 && result[result.length - 1] === "") {
    result.pop();
  }

  return result.join("\n");
}

function applyRound2(chunks: string[]): { chunks: string[]; mediumCompressed: number } {
  let mediumCompressed = 0;

  const result = chunks.map(chunk => {
    const blocks = splitChunkIntoBlocks(chunk);
    const updated = blocks.map(b => {
      if (b.severity !== "MEDIUM") return b;
      const compressed = compressMediumToSummary(b.text);
      if (compressed !== b.text) {
        mediumCompressed++;
        return { ...b, text: compressed };
      }
      return b;
    });
    return joinBlocks(updated);
  });

  return { chunks: result, mediumCompressed };
}

// ---------------------------------------------------------------------------
// Round 3: Compress MEDIUM to title lines only
// ---------------------------------------------------------------------------

function applyRound3(chunks: string[]): { chunks: string[]; mediumCompressed: number } {
  let mediumCompressed = 0;

  const result = chunks.map(chunk => {
    const blocks = splitChunkIntoBlocks(chunk);
    let chunkMediumCount = 0;
    const updated = blocks.map(b => {
      if (b.severity !== "MEDIUM") return b;
      const lines = b.text.split("\n").filter(l => l.trim() !== "");
      // Keep only the first non-empty line (the title / marker line)
      const titleOnly = lines.slice(0, 1).join("\n");
      if (titleOnly !== b.text.trim()) {
        chunkMediumCount++;
      }
      return { ...b, text: titleOnly };
    });

    if (chunkMediumCount > 0) {
      mediumCompressed += chunkMediumCount;
      updated.push({
        severity: "MEDIUM",
        text: `[${chunkMediumCount} MEDIUM findings compressed to titles]`,
      });
    }

    return joinBlocks(updated);
  });

  return { chunks: result, mediumCompressed };
}

// ---------------------------------------------------------------------------
// Round 4: Proportional truncation
// ---------------------------------------------------------------------------

function applyRound4(chunks: string[], availableChars: number): { chunks: string[]; warning: string } {
  const charsPerChunk = Math.floor(availableChars / chunks.length);
  let pathological = false;

  const result = chunks.map(chunk => {
    if (chunk.length <= charsPerChunk) return chunk;

    // Extract HIGH blocks first — must not be truncated
    const lines = chunk.split("\n");
    const highLines: string[] = [];
    const otherLines: string[] = [];
    let inHigh = false;
    for (const line of lines) {
      if (/^(###\s*HIGH|\[HIGH\]|\*\*HIGH\*\*)/i.test(line.trim())) inHigh = true;
      if (inHigh) highLines.push(line);
      else otherLines.push(line);
    }

    const highContent = highLines.join("\n");
    const highChars = highContent.length;
    const remainingChars = Math.max(0, charsPerChunk - highChars);

    if (highChars > charsPerChunk) {
      // Pathological: HIGH alone exceeds budget — keep HIGH intact, drop other content
      pathological = true;
      return highContent.trim();
    }

    const otherContent = otherLines.join("\n").slice(0, remainingChars);
    return (otherContent + "\n" + highContent).trim();
  });

  const warning = pathological
    ? `Reduce pass: proportional truncation applied (${chunks.length} chunks) — HIGH content alone exceeds per-chunk budget in some chunks`
    : `Reduce pass: proportional truncation applied (${chunks.length} chunks)`;

  return { chunks: result, warning };
}

// ============================================================================
// truncateForReduce
// ============================================================================

/**
 * Truncates map-phase review findings to fit within `availableBudget` tokens,
 * preserving HIGH severity findings as long as possible.
 *
 * Applies up to 4 rounds of progressively aggressive truncation:
 *   1. Remove all LOW findings
 *   2. Compress MEDIUM to title + first paragraph
 *   3. Compress MEDIUM to title lines only
 *   4. Proportional truncation across all chunks
 */
export function truncateForReduce(
  chunkFindings: string[],
  availableBudget: number
): TruncationResult {
  const warnings: string[] = [];

  // Fast path: already fits
  if (totalTokens(chunkFindings) <= availableBudget) {
    return { truncated: chunkFindings.slice(), warnings: [], didTruncate: false };
  }

  let current = chunkFindings.slice();

  // --- Round 1: remove LOW ---
  const r1 = applyRound1(current);
  if (r1.lowOmitted > 0) {
    current = r1.chunks;
    warnings.push(
      `Reduce pass: truncated LOW findings (${r1.lowOmitted} omitted across ${r1.chunksAffected} chunks)`
    );
    if (totalTokens(current) <= availableBudget) {
      return { truncated: current, warnings, didTruncate: true };
    }
  }

  // --- Round 2: compress MEDIUM to summary ---
  const r2 = applyRound2(current);
  if (r2.mediumCompressed > 0) {
    current = r2.chunks;
    warnings.push(
      `Reduce pass: compressed ${r2.mediumCompressed} MEDIUM findings to summaries`
    );
    if (totalTokens(current) <= availableBudget) {
      return { truncated: current, warnings, didTruncate: true };
    }
  }

  // --- Round 3: compress MEDIUM to titles ---
  const r3 = applyRound3(current);
  if (r3.mediumCompressed > 0) {
    current = r3.chunks;
    warnings.push(
      `Reduce pass: compressed ${r3.mediumCompressed} MEDIUM findings to titles`
    );
    if (totalTokens(current) <= availableBudget) {
      return { truncated: current, warnings, didTruncate: true };
    }
  }

  // --- Round 4: proportional truncation (HIGH content preserved) ---
  const r4 = applyRound4(current, availableBudget * 4);
  current = r4.chunks;
  warnings.push(r4.warning);

  return { truncated: current, warnings, didTruncate: true };
}
