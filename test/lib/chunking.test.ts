// test/lib/chunking.test.ts
import { describe, it, expect } from "vitest";
import { splitDiffByFile, binPackFiles, splitFileByHunks } from "../../src/lib/chunking.js";
import { ReviewError } from "../../src/lib/types.js";
import type { FileSegment } from "../../src/lib/chunking.js";

// ============================================================================
// Test fixtures
// ============================================================================

const SINGLE_FILE_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index abc1234..def5678 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -10,5 +10,8 @@
 context line
-removed line
+added line one
+added line two
+added line three
 another context
`;

const MULTI_FILE_DIFF = `diff --git a/src/alpha.ts b/src/alpha.ts
index 000000..111111 100644
--- a/src/alpha.ts
+++ b/src/alpha.ts
@@ -1,3 +1,5 @@
 line one
+added line
 line two
+another added
 line three
diff --git a/src/beta.ts b/src/beta.ts
index 222222..333333 100644
--- a/src/beta.ts
+++ b/src/beta.ts
@@ -5,4 +5,6 @@
 existing line
+new feature
 more content
+extra line
 end
diff --git a/src/gamma.ts b/src/gamma.ts
index 444444..555555 100644
--- a/src/gamma.ts
+++ b/src/gamma.ts
@@ -1,2 +1,3 @@
 first
+inserted
 last
`;

const ADDED_FILE_DIFF = `diff --git a/src/new-file.ts b/src/new-file.ts
new file mode 100644
index 0000000..aabbcc
--- /dev/null
+++ b/src/new-file.ts
@@ -0,0 +1,5 @@
+import { something } from "./mod";
+
+export function newFn() {
+  return 42;
+}
`;

const BINARY_FILE_DIFF = `diff --git a/assets/image.png b/assets/image.png
index abc..def 100644
Binary files a/assets/image.png and b/assets/image.png differ
diff --git a/src/app.ts b/src/app.ts
index 111..222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 const x = 1;
+const y = 2;
 const z = 3;
 export { x };
`;

const NO_DIFF_BOUNDARY = `--- a/src/old.ts
+++ b/src/new.ts
@@ -1,3 +1,3 @@
 line one
-old line
+new line
 line three
`;

const MALFORMED_HUNK_DIFF = `diff --git a/src/broken.ts b/src/broken.ts
index abc..def 100644
--- a/src/broken.ts
+++ b/src/broken.ts
@@ INVALID HEADER @@
 some content here
+added line
-removed line
`;

const MULTI_HUNK_FILE_DIFF = `diff --git a/src/large.ts b/src/large.ts
index aaa..bbb 100644
--- a/src/large.ts
+++ b/src/large.ts
@@ -1,5 +1,6 @@
 line 1
+new line
 line 2
 line 3
 line 4
 line 5
@@ -20,5 +21,6 @@
 line 20
+another new line
 line 21
 line 22
 line 23
 line 24
@@ -40,4 +42,5 @@
 line 40
 line 41
+yet another line
 line 42
 line 43
`;

// ============================================================================
// splitDiffByFile tests
// ============================================================================

describe("splitDiffByFile", () => {
  it("standard multi-file diff → correct number of segments", () => {
    const { segments, warnings } = splitDiffByFile(MULTI_FILE_DIFF);
    expect(segments).toHaveLength(3);
    expect(warnings).toHaveLength(0);

    expect(segments[0].path).toBe("src/alpha.ts");
    expect(segments[1].path).toBe("src/beta.ts");
    expect(segments[2].path).toBe("src/gamma.ts");
  });

  it("each segment contains raw diff text including diff --git header", () => {
    const { segments } = splitDiffByFile(MULTI_FILE_DIFF);
    for (const seg of segments) {
      expect(seg.raw).toContain("diff --git");
    }
  });

  it("estimatedTokens = raw.length / 4", () => {
    const { segments } = splitDiffByFile(SINGLE_FILE_DIFF);
    expect(segments[0].estimatedTokens).toBe(Math.floor(segments[0].raw.length / 4));
  });

  it("single file diff → one segment", () => {
    const { segments, warnings } = splitDiffByFile(SINGLE_FILE_DIFF);
    expect(segments).toHaveLength(1);
    expect(warnings).toHaveLength(0);
    expect(segments[0].path).toBe("src/foo.ts");
  });

  it("added file (@@ -0,0 +1,N @@) → parsed correctly with startLine 1", () => {
    const { segments, warnings } = splitDiffByFile(ADDED_FILE_DIFF);
    expect(segments).toHaveLength(1);
    expect(warnings).toHaveLength(0);
    expect(segments[0].path).toBe("src/new-file.ts");
    expect(segments[0].hunks).toHaveLength(1);
    expect(segments[0].hunks[0].startLine).toBe(1);
  });

  it("no diff --git boundary → returns single 'unknown' segment", () => {
    const { segments, warnings } = splitDiffByFile(NO_DIFF_BOUNDARY);
    expect(segments).toHaveLength(1);
    expect(warnings).toHaveLength(0);
    expect(segments[0].path).toBe("unknown");
  });

  it("binary file → excluded from segments with warning", () => {
    const { segments, warnings } = splitDiffByFile(BINARY_FILE_DIFF);
    // binary file excluded
    expect(segments).toHaveLength(1);
    expect(segments[0].path).toBe("src/app.ts");
    // warning issued for binary
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("assets/image.png");
  });

  it("malformed hunk header → segment still returned with warning", () => {
    const { segments, warnings } = splitDiffByFile(MALFORMED_HUNK_DIFF);
    expect(segments).toHaveLength(1);
    expect(segments[0].path).toBe("src/broken.ts");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("src/broken.ts");
  });

  it("parses hunk headers from standard diff", () => {
    const { segments } = splitDiffByFile(SINGLE_FILE_DIFF);
    expect(segments[0].hunks).toHaveLength(1);
    expect(segments[0].hunks[0].startLine).toBe(10);
    expect(segments[0].hunks[0].header).toContain("@@ -10,5 +10,8 @@");
  });

  it("parses multi-hunk file correctly", () => {
    const { segments } = splitDiffByFile(MULTI_HUNK_FILE_DIFF);
    expect(segments).toHaveLength(1);
    expect(segments[0].hunks).toHaveLength(3);
    expect(segments[0].hunks[0].startLine).toBe(1);
    expect(segments[0].hunks[1].startLine).toBe(21);
    expect(segments[0].hunks[2].startLine).toBe(42);
  });

  it("deleted file hunk header (@@ -1,45 +0,0 @@) has startLine 0", () => {
    const deletedFileDiff = `diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index abc..000
--- a/src/old.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-line one
-line two
-line three
`;
    const { segments } = splitDiffByFile(deletedFileDiff);
    expect(segments[0].hunks[0].startLine).toBe(0);
  });

  it("empty string → returns empty segments array", () => {
    const { segments, warnings } = splitDiffByFile("");
    expect(segments).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it("whitespace-only string → returns empty segments array", () => {
    const { segments, warnings } = splitDiffByFile("   \n\t  ");
    expect(segments).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it("hunk header with omitted count (@@ -1 +1 @@) treated as count=1", () => {
    const singleLineDiff = `diff --git a/src/single.ts b/src/single.ts
index abc..def 100644
--- a/src/single.ts
+++ b/src/single.ts
@@ -1 +1 @@
-old
+new
`;
    const { segments } = splitDiffByFile(singleLineDiff);
    expect(segments[0].hunks).toHaveLength(1);
    expect(segments[0].hunks[0].startLine).toBe(1);
  });
});

// ============================================================================
// binPackFiles tests
// ============================================================================

describe("binPackFiles", () => {
  function makeSegment(path: string, tokens: number): FileSegment {
    const raw = "x".repeat(tokens * 4);
    return {
      path,
      raw,
      estimatedTokens: tokens,
      hunks: [],
    };
  }

  it("all files fit in one chunk → returns 1 chunk", () => {
    const segments = [
      makeSegment("a.ts", 100),
      makeSegment("b.ts", 100),
      makeSegment("c.ts", 100),
    ];
    const chunks = binPackFiles(segments, 10000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(3);
  });

  it("3 files need 2 chunks → correct split", () => {
    // Budget: 500 tokens. Three files: 300, 200, 200
    // Sorted descending: 300, 200, 200
    // overhead per file = 10; fits formula: current + file + overhead*(n+1) < 500
    // Chunk 1: 300 → 300 + 10*1 = 310 < 500 ✓; add 200 → 310 + 200 + 10*2 = 530 ≥ 500 ✗ → seal
    // Chunk 2: 200 → fits
    const segments = [
      makeSegment("a.ts", 200),
      makeSegment("b.ts", 300),
      makeSegment("c.ts", 200),
    ];
    const chunks = binPackFiles(segments, 500);
    expect(chunks).toHaveLength(2);
    // chunk 0 has the 300-token file (largest single item); chunk 1 gets the two 200-token files
    // With FFD: bin0=[300]=300 total, bin1=[200,200]=400 total — bin1 can be larger
    expect(chunks[0].some((f) => f.estimatedTokens === 300)).toBe(true);
    const chunk0Tokens = chunks[0].reduce((s, f) => s + f.estimatedTokens, 0);
    const chunk1Tokens = chunks[1].reduce((s, f) => s + f.estimatedTokens, 0);
    expect(chunk0Tokens + chunk1Tokens).toBe(700); // 300 + 200 + 200
  });

  it("files sorted largest-first (FFD)", () => {
    const segments = [
      makeSegment("small.ts", 50),
      makeSegment("large.ts", 400),
      makeSegment("medium.ts", 200),
    ];
    const chunks = binPackFiles(segments, 10000);
    // All in one chunk, but check sorting: large first
    expect(chunks[0][0].path).toBe("large.ts");
    expect(chunks[0][1].path).toBe("medium.ts");
    expect(chunks[0][2].path).toBe("small.ts");
  });

  it("equal token estimates tie-break alphabetically", () => {
    const segments = [
      makeSegment("zebra.ts", 100),
      makeSegment("alpha.ts", 100),
      makeSegment("middle.ts", 100),
    ];
    const chunks = binPackFiles(segments, 10000);
    expect(chunks[0][0].path).toBe("alpha.ts");
    expect(chunks[0][1].path).toBe("middle.ts");
    expect(chunks[0][2].path).toBe("zebra.ts");
  });

  it("3 files of budget/3 - 5 tokens each fit in one chunk (overhead model consistent)", () => {
    // budget=300, each file=95 tokens (300/3 - 5)
    // overhead for 3 files = 10 * 3 = 30; total = 3*95 + 30 = 315 — does NOT fit
    // but with FFD: placing file 3 into chunk with 2 files:
    //   chunkTokens=190 (no overhead baked in) + 95 + 10*(2+1)=30 = 315 >= 300 → FAILS
    // Use budget=360: 3 files of 360/3 - 5 = 115 each
    //   total tokens = 345, overhead = 30, total = 375 >= 360 → still fails
    // Correct test: 3 files where tokens+overhead fits.
    // budget=400, each file = 120 tokens.
    //   place file1: 0 + 120 + 10*1 = 130 < 400 ✓ chunkTokens=120
    //   place file2: 120 + 120 + 10*2 = 260 < 400 ✓ chunkTokens=240
    //   place file3: 240 + 120 + 10*3 = 390 < 400 ✓ → all in 1 chunk
    // With old (double-counting) model:
    //   chunkTokens after file1 = 130 (120+10)
    //   chunkTokens after file2 = 260 (130+120+10)
    //   fit check for file3: 260 + 120 + 10*3 = 410 >= 400 → wrongly splits
    const budget = 400;
    const fileTokens = 120; // budget/3 - ~13
    const segments = [
      makeSegment("a.ts", fileTokens),
      makeSegment("b.ts", fileTokens),
      makeSegment("c.ts", fileTokens),
    ];
    const chunks = binPackFiles(segments, budget);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(3);
  });

  it("chunkBudget <= 0 → throws ReviewError with invalid_model_limits", () => {
    const segments = [makeSegment("a.ts", 100)];
    expect(() => binPackFiles(segments, 0)).toThrow(ReviewError);
    expect(() => binPackFiles(segments, 0)).toThrow(
      expect.objectContaining({ code: "invalid_model_limits" })
    );
    expect(() => binPackFiles(segments, -1)).toThrow(ReviewError);
  });

  it("single file exceeds budget → hunk-level split invoked (multiple chunks returned)", () => {
    // Create a file with hunks that collectively exceed budget but can be split
    const hunk1Raw = "+" + "a".repeat(200) + "\n";
    const hunk2Raw = "+" + "b".repeat(200) + "\n";
    const hunk1: import("../../src/lib/chunking.js").HunkSegment = {
      header: "@@ -1,5 +1,5 @@",
      raw: hunk1Raw,
      startLine: 1,
      estimatedTokens: Math.floor(hunk1Raw.length / 4),
    };
    const hunk2: import("../../src/lib/chunking.js").HunkSegment = {
      header: "@@ -10,5 +10,5 @@",
      raw: hunk2Raw,
      startLine: 10,
      estimatedTokens: Math.floor(hunk2Raw.length / 4),
    };
    const raw = "diff --git a/big.ts b/big.ts\n" + hunk1Raw + hunk2Raw;
    const bigSegment: FileSegment = {
      path: "big.ts",
      raw,
      estimatedTokens: Math.floor(raw.length / 4),
      hunks: [hunk1, hunk2],
    };

    // Budget smaller than file but larger than individual hunks
    const budget = 80;
    const chunks = binPackFiles([bigSegment], budget);
    // Should produce multiple chunks (hunk-split)
    expect(chunks.length).toBeGreaterThan(1);
  });
});

// ============================================================================
// splitFileByHunks tests
// ============================================================================

describe("splitFileByHunks", () => {
  function makeHunk(startLine: number, content: string): import("../../src/lib/chunking.js").HunkSegment {
    const header = `@@ -${startLine},10 +${startLine},10 @@`;
    const raw = header + "\n" + content;
    return {
      header,
      raw,
      startLine,
      estimatedTokens: Math.floor(raw.length / 4),
    };
  }

  it("multiple hunks → bin-packed into multiple chunks when budget is tight", () => {
    const hunk1Content = "+" + "a".repeat(196) + "\n";
    const hunk2Content = "+" + "b".repeat(196) + "\n";
    const hunk3Content = "+" + "c".repeat(196) + "\n";

    const h1 = makeHunk(1, hunk1Content);
    const h2 = makeHunk(20, hunk2Content);
    const h3 = makeHunk(40, hunk3Content);

    const segment: FileSegment = {
      path: "src/large.ts",
      raw: h1.raw + h2.raw + h3.raw,
      estimatedTokens: Math.floor((h1.raw + h2.raw + h3.raw).length / 4),
      hunks: [h1, h2, h3],
    };

    // Budget that fits 1 hunk but not 2
    const budget = 70;
    const chunks = splitFileByHunks(segment, budget);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("single hunk exceeds budget → truncated with marker at nearest newline", () => {
    const longContent = "+" + "a".repeat(400) + "\nsome line here\n";
    const header = "@@ -1,5 +1,5 @@";
    const hunkRaw = header + "\n" + longContent;
    const hunk: import("../../src/lib/chunking.js").HunkSegment = {
      header,
      raw: hunkRaw,
      startLine: 1,
      estimatedTokens: Math.floor(hunkRaw.length / 4),
    };

    const segment: FileSegment = {
      path: "src/huge.ts",
      raw: hunkRaw,
      estimatedTokens: Math.floor(hunkRaw.length / 4),
      hunks: [hunk],
    };

    const budget = 50;
    const chunks = splitFileByHunks(segment, budget);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(1);

    const resultRaw = chunks[0][0].raw;
    expect(resultRaw).toContain("[truncated");
    expect(resultRaw).toContain("tokens reduced to");
    // Header preserved
    expect(resultRaw).toContain(header);
  });

  it("no newline within 1000 chars → truncated at limit", () => {
    // A hunk with no newline in the content portion (beyond header)
    const header = "@@ -1,5 +1,5 @@";
    // 2000 chars of 'x' with no newline
    const noNewlineContent = "x".repeat(2000);
    const hunkRaw = header + "\n" + noNewlineContent;
    const hunk: import("../../src/lib/chunking.js").HunkSegment = {
      header,
      raw: hunkRaw,
      startLine: 1,
      estimatedTokens: Math.floor(hunkRaw.length / 4),
    };

    const segment: FileSegment = {
      path: "src/nonewline.ts",
      raw: hunkRaw,
      estimatedTokens: Math.floor(hunkRaw.length / 4),
      hunks: [hunk],
    };

    const budget = 100;
    const chunks = splitFileByHunks(segment, budget);
    expect(chunks).toHaveLength(1);

    const resultRaw = chunks[0][0].raw;
    expect(resultRaw).toContain("[truncated");
  });

  it("segment with zero parseable hunks → treated as single hunk", () => {
    const raw = "diff --git a/src/empty.ts b/src/empty.ts\nsome header\n";
    const segment: FileSegment = {
      path: "src/empty.ts",
      raw,
      estimatedTokens: Math.floor(raw.length / 4),
      hunks: [],
    };

    // Budget large enough for the segment
    const budget = 1000;
    const chunks = splitFileByHunks(segment, budget);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(1);
  });
});
