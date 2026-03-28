// test/lib/prompt.test.ts
import { describe, it, expect } from "vitest";
import { loadBuiltInPrompt, assembleUserMessage } from "../../src/lib/prompt.js";
import type { DiffResult } from "../../src/lib/types.js";

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
});
