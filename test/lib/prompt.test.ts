// test/lib/prompt.test.ts
import { describe, it, expect } from "vitest";
import {
  loadBuiltInPrompt,
  assembleUserMessage,
  assembleFileManifest,
  extractHunkRanges,
  assembleChunkMessage,
  assembleReduceMessage,
  getReduceSystemPrompt,
} from "../../src/lib/prompt.js";
import type { DiffResult, FileChange } from "../../src/lib/types.js";
import type { FileSegment } from "../../src/lib/chunking.js";

describe("loadBuiltInPrompt", () => {
  it("loads the built-in prompt from prompts/default-review.md", () => {
    const prompt = loadBuiltInPrompt();

    expect(prompt).toBeTruthy();
    expect(prompt).toContain("Code Review Guidelines");
    expect(prompt).toContain("Priority Order");
    expect(prompt).toContain("Security");
    expect(prompt).toContain("Correctness");
    expect(prompt).toContain("Performance");
    expect(prompt).toContain("Output Format");
    expect(prompt).toContain("Review Rules");
  });

  it("returns a non-empty string", () => {
    const prompt = loadBuiltInPrompt();
    expect(prompt.length).toBeGreaterThan(100);
  });
});

describe("assembleUserMessage", () => {
  it("formats a simple diff with file changes", () => {
    const diff: DiffResult = {
      raw: "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new",
      files: [
        {
          path: "foo.ts",
          status: "modified",
          insertions: 1,
          deletions: 1,
        },
      ],
      stats: {
        filesChanged: 1,
        insertions: 1,
        deletions: 1,
      },
    };

    const message = assembleUserMessage(diff);

    expect(message).toContain("Review the following changes.");
    expect(message).toContain("## Summary");
    expect(message).toContain("Files changed: 1");
    expect(message).toContain("Insertions: +1, Deletions: -1");
    expect(message).toContain("## Diff");
    expect(message).toContain("```diff");
    expect(message).toContain(diff.raw);
    expect(message).toContain("```");
  });

  it("formats diff with multiple files", () => {
    const diff: DiffResult = {
      raw: "diff content here",
      files: [
        { path: "a.ts", status: "modified", insertions: 5, deletions: 2 },
        { path: "b.ts", status: "added", insertions: 10, deletions: 0 },
      ],
      stats: {
        filesChanged: 2,
        insertions: 15,
        deletions: 2,
      },
    };

    const message = assembleUserMessage(diff);

    expect(message).toContain("Files changed: 2");
    expect(message).toContain("Insertions: +15, Deletions: -2");
  });

  it("formats diff with zero deletions", () => {
    const diff: DiffResult = {
      raw: "diff content",
      files: [{ path: "new.ts", status: "added", insertions: 20, deletions: 0 }],
      stats: {
        filesChanged: 1,
        insertions: 20,
        deletions: 0,
      },
    };

    const message = assembleUserMessage(diff);

    expect(message).toContain("Insertions: +20, Deletions: -0");
  });

  it("includes raw diff in code block", () => {
    const rawDiff = "diff --git a/test.ts b/test.ts\nindex 123..456\n--- a/test.ts\n+++ b/test.ts";
    const diff: DiffResult = {
      raw: rawDiff,
      files: [{ path: "test.ts", status: "modified", insertions: 1, deletions: 1 }],
      stats: { filesChanged: 1, insertions: 1, deletions: 1 },
    };

    const message = assembleUserMessage(diff);

    expect(message).toContain("```diff");
    expect(message).toContain(rawDiff);
    expect(message).toContain("```");
  });

  it("includes files changed table with file and status columns", () => {
    const diff: DiffResult = {
      raw: "diff content",
      files: [
        { path: "src/foo.ts", status: "modified", insertions: 3, deletions: 1 },
        { path: "src/bar.ts", status: "added", insertions: 10, deletions: 0 },
      ],
      stats: { filesChanged: 2, insertions: 13, deletions: 1 },
    };

    const message = assembleUserMessage(diff);

    expect(message).toContain("## Files Changed");
    expect(message).toContain("| File | Status |");
    expect(message).toContain("| src/foo.ts | modified |");
    expect(message).toContain("| src/bar.ts | added |");
  });

  it("files table appears after Summary section and before Diff section", () => {
    const diff: DiffResult = {
      raw: "diff content",
      files: [{ path: "x.ts", status: "deleted", insertions: 0, deletions: 5 }],
      stats: { filesChanged: 1, insertions: 0, deletions: 5 },
    };

    const message = assembleUserMessage(diff);

    const summaryIdx = message.indexOf("## Summary");
    const filesIdx = message.indexOf("## Files Changed");
    const diffIdx = message.indexOf("## Diff");

    expect(summaryIdx).toBeGreaterThan(-1);
    expect(filesIdx).toBeGreaterThan(summaryIdx);
    expect(diffIdx).toBeGreaterThan(filesIdx);
  });
});

describe("assembleFileManifest", () => {
  it("renders correct table with file, status, and hunk ranges", () => {
    const files: FileChange[] = [
      { path: "src/db/queries.ts", status: "modified", insertions: 20, deletions: 5 },
      { path: "src/api/handler.ts", status: "added", insertions: 89, deletions: 0 },
    ];
    const hunkRanges = new Map<string, string[]>([
      ["src/db/queries.ts", ["42-58", "103-110"]],
      ["src/api/handler.ts", ["1-89"]],
    ]);

    const manifest = assembleFileManifest(files, hunkRanges);

    expect(manifest).toContain("## Files Changed");
    expect(manifest).toContain("| File | Status | Lines Changed |");
    expect(manifest).toContain("|------|--------|---------------|");
    expect(manifest).toContain("| src/db/queries.ts | modified | 42-58, 103-110 |");
    expect(manifest).toContain("| src/api/handler.ts | added | 1-89 |");
  });

  it("shows '-' for files not in hunkRanges", () => {
    const files: FileChange[] = [
      { path: "src/foo.ts", status: "modified", insertions: 5, deletions: 2 },
    ];
    const hunkRanges = new Map<string, string[]>();

    const manifest = assembleFileManifest(files, hunkRanges);

    expect(manifest).toContain("| src/foo.ts | modified | - |");
  });

  it("shows '-' for Lines Changed when file is deleted", () => {
    const files: FileChange[] = [
      { path: "src/gone.ts", status: "deleted", insertions: 0, deletions: 10 },
    ];
    const hunkRanges = new Map<string, string[]>([
      ["src/gone.ts", ["1-10"]],
    ]);

    const manifest = assembleFileManifest(files, hunkRanges);

    // deleted files always show '-' regardless of hunk ranges
    expect(manifest).toContain("| src/gone.ts | deleted | - |");
  });

  it("handles empty files list", () => {
    const manifest = assembleFileManifest([], new Map());

    expect(manifest).toContain("## Files Changed");
    expect(manifest).toContain("| File | Status | Lines Changed |");
    // no data rows
    const lines = manifest.trim().split("\n");
    // header + separator = 3 lines (## heading, | header |, |---|)
    expect(lines.length).toBe(3);
  });
});

describe("extractHunkRanges", () => {
  it("extracts range from a single hunk", () => {
    const segments: FileSegment[] = [
      {
        path: "src/foo.ts",
        raw: "@@ -10,5 +42,17 @@\n+line1\n+line2",
        estimatedTokens: 10,
        hunks: [
          {
            header: "@@ -10,5 +42,17 @@",
            raw: "@@ -10,5 +42,17 @@\n+line1\n+line2",
            startLine: 42,
            estimatedTokens: 10,
          },
        ],
      },
    ];

    const ranges = extractHunkRanges(segments);

    expect(ranges.get("src/foo.ts")).toEqual(["42-58"]);
  });

  it("extracts multiple hunks for the same file", () => {
    const segments: FileSegment[] = [
      {
        path: "src/bar.ts",
        raw: "...",
        estimatedTokens: 20,
        hunks: [
          {
            header: "@@ -1,3 +1,5 @@",
            raw: "@@ -1,3 +1,5 @@\n+a\n+b",
            startLine: 1,
            estimatedTokens: 10,
          },
          {
            header: "@@ -20,2 +22,3 @@",
            raw: "@@ -20,2 +22,3 @@\n+c",
            startLine: 22,
            estimatedTokens: 10,
          },
        ],
      },
    ];

    const ranges = extractHunkRanges(segments);

    expect(ranges.get("src/bar.ts")).toEqual(["1-5", "22-24"]);
  });

  it("handles hunk header with no count (defaults to 1)", () => {
    const segments: FileSegment[] = [
      {
        path: "src/single.ts",
        raw: "@@ -5 +10 @@\n+line",
        estimatedTokens: 5,
        hunks: [
          {
            header: "@@ -5 +10 @@",
            raw: "@@ -5 +10 @@\n+line",
            startLine: 10,
            estimatedTokens: 5,
          },
        ],
      },
    ];

    const ranges = extractHunkRanges(segments);

    // startLine=10, count=1 → 10 to 10
    expect(ranges.get("src/single.ts")).toEqual(["10-10"]);
  });

  it("handles file with no hunks", () => {
    const segments: FileSegment[] = [
      {
        path: "src/nohunks.ts",
        raw: "diff --git ...",
        estimatedTokens: 5,
        hunks: [],
      },
    ];

    const ranges = extractHunkRanges(segments);

    expect(ranges.has("src/nohunks.ts")).toBe(false);
  });

  it("handles multiple files", () => {
    const segments: FileSegment[] = [
      {
        path: "a.ts",
        raw: "...",
        estimatedTokens: 10,
        hunks: [
          {
            header: "@@ -1,3 +1,3 @@",
            raw: "@@ -1,3 +1,3 @@\n context",
            startLine: 1,
            estimatedTokens: 5,
          },
        ],
      },
      {
        path: "b.ts",
        raw: "...",
        estimatedTokens: 10,
        hunks: [
          {
            header: "@@ -5,2 +5,4 @@",
            raw: "@@ -5,2 +5,4 @@\n context",
            startLine: 5,
            estimatedTokens: 5,
          },
        ],
      },
    ];

    const ranges = extractHunkRanges(segments);

    expect(ranges.get("a.ts")).toEqual(["1-3"]);
    expect(ranges.get("b.ts")).toEqual(["5-8"]);
  });

  it("merges ranges correctly when two FileSegments share the same path", () => {
    const segments: FileSegment[] = [
      {
        path: "src/shared.ts",
        raw: "@@ -1,3 +1,4 @@\n+added",
        estimatedTokens: 10,
        hunks: [
          {
            header: "@@ -1,3 +1,4 @@",
            raw: "@@ -1,3 +1,4 @@\n+added",
            startLine: 1,
            estimatedTokens: 5,
          },
        ],
      },
      {
        path: "src/shared.ts",
        raw: "@@ -30,2 +31,5 @@\n+more",
        estimatedTokens: 10,
        hunks: [
          {
            header: "@@ -30,2 +31,5 @@",
            raw: "@@ -30,2 +31,5 @@\n+more",
            startLine: 31,
            estimatedTokens: 5,
          },
        ],
      },
    ];

    const ranges = extractHunkRanges(segments);

    // Both segments' ranges must appear under the single shared path key
    expect(ranges.get("src/shared.ts")).toEqual(["1-4", "31-35"]);
  });

  it("excludes count=0 hunk header from ranges", () => {
    const segments: FileSegment[] = [
      {
        path: "src/ctx.ts",
        raw: "@@ -5,0 +6,0 @@\n context",
        estimatedTokens: 5,
        hunks: [
          {
            header: "@@ -5,0 +6,0 @@",
            raw: "@@ -5,0 +6,0 @@\n context",
            startLine: 6,
            estimatedTokens: 5,
          },
        ],
      },
    ];

    const ranges = extractHunkRanges(segments);

    // count=0 → no range produced; file key omitted entirely
    expect(ranges.has("src/ctx.ts")).toBe(false);
  });
});

describe("assembleChunkMessage", () => {
  const makeSegment = (path: string, raw: string): FileSegment => ({
    path,
    raw,
    estimatedTokens: Math.floor(raw.length / 4),
    hunks: [],
  });

  it("includes chunk header with correct index and total", () => {
    const segments = [makeSegment("a.ts", "diff a")];
    const manifest = "## Files Changed\n| File | Status | Lines Changed |\n|------|--------|---------------|\n| a.ts | modified | - |";

    const msg = assembleChunkMessage(0, 3, segments, manifest);

    expect(msg).toContain("Review chunk 1 of 3.");
  });

  it("includes files in this chunk comma-separated", () => {
    const segments = [
      makeSegment("a.ts", "diff a"),
      makeSegment("b.ts", "diff b"),
    ];
    const manifest = "## Files Changed\n...";

    const msg = assembleChunkMessage(1, 5, segments, manifest);

    expect(msg).toContain("Files in this chunk: a.ts, b.ts");
  });

  it("includes the file manifest", () => {
    const segments = [makeSegment("x.ts", "diff x")];
    const manifest = "## Files Changed\n| File | Status | Lines Changed |\n|------|--------|---------------|\n| x.ts | added | 1-10 |";

    const msg = assembleChunkMessage(0, 1, segments, manifest);

    expect(msg).toContain(manifest);
  });

  it("includes raw diffs of all segments in a diff code block", () => {
    const segments = [
      makeSegment("a.ts", "diff --git a/a.ts b/a.ts\n+line"),
      makeSegment("b.ts", "diff --git a/b.ts b/b.ts\n-removed"),
    ];
    const manifest = "## Files Changed\n...";

    const msg = assembleChunkMessage(0, 2, segments, manifest);

    expect(msg).toContain("```diff");
    expect(msg).toContain("diff --git a/a.ts b/a.ts\n+line");
    expect(msg).toContain("diff --git a/b.ts b/b.ts\n-removed");
    expect(msg).toContain("```");
  });
});

describe("assembleReduceMessage", () => {
  it("includes intro line with chunk count", () => {
    const chunkFindings = [
      { files: ["a.ts"], content: "Finding A" },
      { files: ["b.ts"], content: "Finding B" },
    ];
    const allFiles: FileChange[] = [
      { path: "a.ts", status: "modified", insertions: 1, deletions: 0 },
      { path: "b.ts", status: "added", insertions: 5, deletions: 0 },
    ];
    const allHunkRanges = new Map<string, string[]>();

    const msg = assembleReduceMessage(chunkFindings, allFiles, allHunkRanges);

    expect(msg).toContain("from 2 review passes");
  });

  it("labels each chunk section with its file paths", () => {
    const chunkFindings = [
      { files: ["a.ts", "b.ts"], content: "Chunk 1 findings here" },
      { files: ["c.ts"], content: "Chunk 2 findings here" },
    ];
    const allFiles: FileChange[] = [
      { path: "a.ts", status: "modified", insertions: 1, deletions: 0 },
      { path: "b.ts", status: "modified", insertions: 2, deletions: 0 },
      { path: "c.ts", status: "added", insertions: 5, deletions: 0 },
    ];

    const msg = assembleReduceMessage(chunkFindings, allFiles, new Map());

    expect(msg).toContain("## Chunk 1 (files: a.ts, b.ts)");
    expect(msg).toContain("Chunk 1 findings here");
    expect(msg).toContain("## Chunk 2 (files: c.ts)");
    expect(msg).toContain("Chunk 2 findings here");
  });

  it("ends with full file manifest", () => {
    const chunkFindings = [
      { files: ["a.ts"], content: "some finding" },
    ];
    const allFiles: FileChange[] = [
      { path: "a.ts", status: "modified", insertions: 3, deletions: 1 },
      { path: "b.ts", status: "deleted", insertions: 0, deletions: 7 },
    ];
    const allHunkRanges = new Map<string, string[]>([
      ["a.ts", ["1-10"]],
    ]);

    const msg = assembleReduceMessage(chunkFindings, allFiles, allHunkRanges);

    expect(msg).toContain("## All files in this review (for cross-file analysis)");
    expect(msg).toContain("| a.ts | modified | 1-10 |");
    expect(msg).toContain("| b.ts | deleted | - |");
  });

  it("chunk sections appear before the full file manifest", () => {
    const chunkFindings = [
      { files: ["x.ts"], content: "finding x" },
    ];
    const allFiles: FileChange[] = [
      { path: "x.ts", status: "modified", insertions: 1, deletions: 0 },
    ];

    const msg = assembleReduceMessage(chunkFindings, allFiles, new Map());

    const chunk1Idx = msg.indexOf("## Chunk 1");
    const allFilesIdx = msg.indexOf("## All files in this review");

    expect(chunk1Idx).toBeGreaterThan(-1);
    expect(allFilesIdx).toBeGreaterThan(chunk1Idx);
  });

  it("empty-content chunk produces 'No issues found' placeholder instead of empty section", () => {
    const chunkFindings = [
      { files: ["a.ts"], content: "Found something." },
      { files: ["b.ts"], content: "" },
      { files: ["c.ts"], content: "   " },
    ];
    const allFiles: FileChange[] = [
      { path: "a.ts", status: "modified", insertions: 1, deletions: 0 },
      { path: "b.ts", status: "added", insertions: 3, deletions: 0 },
      { path: "c.ts", status: "modified", insertions: 2, deletions: 1 },
    ];

    const msg = assembleReduceMessage(chunkFindings, allFiles, new Map());

    expect(msg).toContain("## Chunk 1 (files: a.ts)");
    expect(msg).toContain("Found something.");
    expect(msg).toContain("## Chunk 2 (files: b.ts)");
    expect(msg).toContain("No issues found in this chunk.");
    expect(msg).toContain("## Chunk 3 (files: c.ts)");
    // Both empty and whitespace-only content chunks get the placeholder
    const chunk2Idx = msg.indexOf("## Chunk 2 (files: b.ts)");
    const chunk3Idx = msg.indexOf("## Chunk 3 (files: c.ts)");
    const noIssuesCount = (msg.match(/No issues found in this chunk\./g) ?? []).length;
    expect(noIssuesCount).toBe(2);
    // The empty-content chunks must NOT produce adjacent ## headers
    const chunk2Section = msg.slice(chunk2Idx, chunk3Idx);
    expect(chunk2Section).toContain("No issues found in this chunk.");
  });

  it("handles a single chunk correctly", () => {
    const chunkFindings = [
      { files: ["solo.ts"], content: "Only finding" },
    ];
    const allFiles: FileChange[] = [
      { path: "solo.ts", status: "added", insertions: 8, deletions: 0 },
    ];
    const allHunkRanges = new Map<string, string[]>([
      ["solo.ts", ["1-8"]],
    ]);

    const msg = assembleReduceMessage(chunkFindings, allFiles, allHunkRanges);

    expect(msg).toContain("from 1 review passes");
    expect(msg).toContain("## Chunk 1 (files: solo.ts)");
    expect(msg).toContain("Only finding");
    expect(msg).toContain("## All files in this review (for cross-file analysis)");
    expect(msg).toContain("| solo.ts | added | 1-8 |");
  });
});

describe("getReduceSystemPrompt", () => {
  it("returns a non-empty string", () => {
    const prompt = getReduceSystemPrompt();
    expect(prompt).toBeTruthy();
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("contains 'Deduplicate'", () => {
    const prompt = getReduceSystemPrompt();
    expect(prompt).toContain("Deduplicate");
  });

  it("contains cross-file analysis guidance", () => {
    const prompt = getReduceSystemPrompt();
    expect(prompt).toContain("cross-file");
  });
});
