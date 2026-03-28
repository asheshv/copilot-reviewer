// test/lib/formatter.test.ts
import { describe, it, expect } from "vitest";
import { format, formatNdjsonChunk, detectHighSeverity } from "../../src/lib/formatter.js";
import type { ReviewResult, StreamChunk } from "../../src/lib/types.js";

describe("format()", () => {
  const mockResult: ReviewResult = {
    content: "### HIGH SQL injection\n**File:** `db.ts` **Line:** 42\n\nUnsafe query.",
    model: "gpt-4.1",
    usage: { totalTokens: 1234 },
    diff: {
      raw: "diff --git a/db.ts b/db.ts\nindex 123..456 100644\n--- a/db.ts\n+++ b/db.ts",
      files: [{ path: "db.ts", status: "modified", insertions: 10, deletions: 3 }],
      stats: { filesChanged: 1, insertions: 10, deletions: 3 },
    },
    warnings: ["Token budget at 85%"],
  };

  describe("markdown format", () => {
    it("includes header with model, files, stats", () => {
      const output = format(mockResult, "markdown");
      expect(output).toContain("# Copilot Code Review");
      expect(output).toContain("**Model:** gpt-4.1");
      expect(output).toContain("**Files:** 1");
      expect(output).toContain("**+10 -3**");
    });

    it("passes through Copilot content as-is", () => {
      const output = format(mockResult, "markdown");
      expect(output).toContain("### HIGH SQL injection");
      expect(output).toContain("**File:** `db.ts` **Line:** 42");
      expect(output).toContain("Unsafe query.");
    });

    it("includes footer with token usage", () => {
      const output = format(mockResult, "markdown");
      expect(output).toContain("*Tokens used: 1,234");
      expect(output).toContain("Model: gpt-4.1*");
    });

    it("includes Findings section header", () => {
      const output = format(mockResult, "markdown");
      expect(output).toContain("## Findings");
    });

    it("includes separator line before footer", () => {
      const output = format(mockResult, "markdown");
      expect(output).toContain("---");
    });
  });

  describe("text format", () => {
    const mockMarkdownContent: ReviewResult = {
      content:
        "## Review Results\n\n" +
        "### HIGH Security Issue\n\n" +
        "**File:** `auth.ts`\n\n" +
        "```typescript\n" +
        "const token = process.env.TOKEN;\n" +
        "```\n\n" +
        "This is a *critical* issue that needs **immediate** attention.",
      model: "gpt-4.1",
      usage: { totalTokens: 500 },
      diff: {
        raw: "...",
        files: [{ path: "auth.ts", status: "modified", insertions: 5, deletions: 2 }],
        stats: { filesChanged: 1, insertions: 5, deletions: 2 },
      },
      warnings: [],
    };

    it("strips markdown headers to plain text", () => {
      const output = format(mockMarkdownContent, "text");
      expect(output).toContain("Review Results");
      expect(output).toContain("HIGH Security Issue");
      expect(output).not.toContain("##");
      expect(output).not.toContain("###");
    });

    it("strips code fences to indented blocks", () => {
      const output = format(mockMarkdownContent, "text");
      expect(output).toContain("    const token = process.env.TOKEN;");
      expect(output).not.toContain("```typescript");
      expect(output).not.toContain("```\n\n");
    });

    it("strips bold/italic formatting", () => {
      const output = format(mockMarkdownContent, "text");
      expect(output).toContain("File: auth.ts");
      expect(output).toContain("critical");
      expect(output).toContain("immediate");
      expect(output).not.toContain("**");
      expect(output).not.toContain("*critical*");
    });

    it("includes plain header with model, files, stats", () => {
      const output = format(mockMarkdownContent, "text");
      expect(output).toContain("Copilot Code Review");
      expect(output).toContain("Model: gpt-4.1");
      expect(output).toContain("Files: 1");
      expect(output).toContain("+5 -2");
    });

    it("includes plain footer with token usage", () => {
      const output = format(mockMarkdownContent, "text");
      expect(output).toContain("Tokens used: 500");
      expect(output).not.toContain("*Tokens used:");
    });
  });

  describe("json format", () => {
    it("produces valid JSON", () => {
      const output = format(mockResult, "json");
      expect(() => JSON.parse(output)).not.toThrow();
    });

    it("nests review under review key", () => {
      const output = format(mockResult, "json");
      const parsed = JSON.parse(output);
      expect(parsed.review).toBeDefined();
      expect(parsed.review.content).toBe(mockResult.content);
      expect(parsed.review.model).toBe("gpt-4.1");
      expect(parsed.review.usage).toEqual({ totalTokens: 1234 });
    });

    it("flattens diff stats into top-level diff", () => {
      const output = format(mockResult, "json");
      const parsed = JSON.parse(output);
      expect(parsed.diff).toBeDefined();
      expect(parsed.diff.filesChanged).toBe(1);
      expect(parsed.diff.insertions).toBe(10);
      expect(parsed.diff.deletions).toBe(3);
      expect(parsed.diff.files).toHaveLength(1);
      expect(parsed.diff.files[0].path).toBe("db.ts");
    });

    it("includes warnings array", () => {
      const output = format(mockResult, "json");
      const parsed = JSON.parse(output);
      expect(parsed.warnings).toEqual(["Token budget at 85%"]);
    });

    it("includes exitCode field based on HIGH severity", () => {
      const output = format(mockResult, "json");
      const parsed = JSON.parse(output);
      expect(parsed.exitCode).toBe(1);
    });

    it("sets exitCode to 0 when no HIGH severity present", () => {
      const safeResult = { ...mockResult, content: "### MEDIUM Code style\nMinor issue." };
      const output = format(safeResult, "json");
      const parsed = JSON.parse(output);
      expect(parsed.exitCode).toBe(0);
    });
  });

  describe("empty warnings", () => {
    it("handles empty warnings array in all formats", () => {
      const resultNoWarnings = { ...mockResult, warnings: [] };

      expect(() => format(resultNoWarnings, "markdown")).not.toThrow();
      expect(() => format(resultNoWarnings, "text")).not.toThrow();

      const jsonOutput = format(resultNoWarnings, "json");
      const parsed = JSON.parse(jsonOutput);
      expect(parsed.warnings).toEqual([]);
    });
  });

  describe("number formatting", () => {
    it("formats large token counts with comma separators", () => {
      const largeResult = { ...mockResult, usage: { totalTokens: 123456 } };
      const mdOutput = format(largeResult, "markdown");
      const textOutput = format(largeResult, "text");

      expect(mdOutput).toContain("123,456");
      expect(textOutput).toContain("123,456");
    });
  });
});

describe("detectHighSeverity()", () => {
  it("returns true when content contains ### HIGH", () => {
    expect(detectHighSeverity("### HIGH SQL injection\nDetails...")).toBe(true);
  });

  it("returns true when content contains [HIGH]", () => {
    expect(detectHighSeverity("[HIGH] Critical bug found")).toBe(true);
  });

  it("returns true for multiple HIGH occurrences", () => {
    expect(detectHighSeverity("### HIGH Issue 1\n\n[HIGH] Issue 2")).toBe(true);
  });

  it("returns false when no HIGH patterns present", () => {
    expect(detectHighSeverity("### MEDIUM Code style\n### LOW Typo")).toBe(false);
  });

  it("returns false for empty content", () => {
    expect(detectHighSeverity("")).toBe(false);
  });

  it("is case-sensitive (does not match ### high)", () => {
    expect(detectHighSeverity("### high priority issue")).toBe(false);
    expect(detectHighSeverity("[high] issue")).toBe(false);
  });

  it("does not match HIGH in middle of words", () => {
    expect(detectHighSeverity("HIGHLIGHT this issue")).toBe(false);
    expect(detectHighSeverity("highly important")).toBe(false);
  });

  it("matches HIGH at start of line after ###", () => {
    expect(detectHighSeverity("Some text\n### HIGH Security\nMore text")).toBe(true);
  });
});

describe("formatNdjsonChunk()", () => {
  it("serializes content chunk as single JSON line", () => {
    const chunk: StreamChunk = { type: "content", text: "Review findings..." };
    const output = formatNdjsonChunk(chunk);

    expect(output).toBe('{"type":"content","text":"Review findings..."}\n');
    expect(output.endsWith("\n")).toBe(true);
    expect(output.split("\n").length).toBe(2); // content + trailing newline = 2 parts
  });

  it("serializes done chunk with usage and model", () => {
    const chunk: StreamChunk = {
      type: "done",
      usage: { totalTokens: 1234 },
      model: "gpt-4.1"
    };
    const output = formatNdjsonChunk(chunk);

    const parsed = JSON.parse(output.trim());
    expect(parsed.type).toBe("done");
    expect(parsed.usage).toEqual({ totalTokens: 1234 });
    expect(parsed.model).toBe("gpt-4.1");
    expect(output.endsWith("\n")).toBe(true);
  });

  it("serializes warning chunk", () => {
    const chunk: StreamChunk = { type: "warning", text: "Token budget at 85%" };
    const output = formatNdjsonChunk(chunk);

    expect(output).toBe('{"type":"warning","text":"Token budget at 85%"}\n');
    expect(output.endsWith("\n")).toBe(true);
  });

  it("each line ends with newline", () => {
    const chunks: StreamChunk[] = [
      { type: "content", text: "line1" },
      { type: "content", text: "line2" },
      { type: "done", usage: { totalTokens: 100 }, model: "gpt-4" },
    ];

    chunks.forEach(chunk => {
      const output = formatNdjsonChunk(chunk);
      expect(output.endsWith("\n")).toBe(true);
    });
  });

  it("handles chunks with special characters in text", () => {
    const chunk: StreamChunk = {
      type: "content",
      text: 'Line with "quotes" and\nnewlines\tand\ttabs'
    };
    const output = formatNdjsonChunk(chunk);

    const parsed = JSON.parse(output.trim());
    expect(parsed.text).toBe('Line with "quotes" and\nnewlines\tand\ttabs');
  });

  it("omits undefined fields", () => {
    const chunk: StreamChunk = { type: "content" };
    const output = formatNdjsonChunk(chunk);

    expect(output).toBe('{"type":"content"}\n');
    expect(output).not.toContain("text");
  });
});
