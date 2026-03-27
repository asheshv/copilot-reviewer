# Task 09: Output Formatter

[Back to Plan Index](./README.md) | Prev: [08 — Config+Prompt](./08-config-prompt.md) | Next: [10 — Review](./10-review.md)

**Dependencies:** Task 2 (types)
**Spec ref:** [11 — Formatter](../spec/11-formatter.md)

**Files:**
- Create: `src/lib/formatter.ts`
- Test: `test/lib/formatter.test.ts`

---

- [ ] **Step 1: Write failing tests**

```typescript
describe("format()", () => {
  const mockResult: ReviewResult = {
    content: "### HIGH SQL injection\n**File:** `db.ts` **Line:** 42\n\nUnsafe query.",
    model: "gpt-4.1",
    usage: { totalTokens: 1234 },
    diff: {
      raw: "...",
      files: [{ path: "db.ts", status: "modified", insertions: 10, deletions: 3 }],
      stats: { filesChanged: 1, insertions: 10, deletions: 3 },
    },
    warnings: ["Token budget at 85%"],
  };

  describe("markdown format", () => {
    it("includes header with model, files, stats");
    it("passes through Copilot content as-is");
    it("includes footer with token usage");
  });

  describe("text format", () => {
    it("strips markdown headers to plain text");
    it("strips code fences to indented blocks");
    it("strips bold/italic formatting");
  });

  describe("json format", () => {
    it("produces valid JSON");
    it("nests review under review key");
    it("flattens diff stats into top-level diff");
    it("includes warnings array");
    it("includes exitCode field");
  });
});

describe("detectHighSeverity()", () => {
  it("returns true when content contains ### HIGH");
  it("returns true when content contains [HIGH]");
  it("returns false when no HIGH patterns present");
  it("returns false for empty content");
  it("is case-sensitive (does not match ### high)");
});

describe("formatNdjsonChunk()", () => {
  it("serializes content chunk as single JSON line");
  it("serializes done chunk with usage and model");
  it("serializes warning chunk");
  it("each line ends with newline");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL.

- [ ] **Step 3: Implement formatter.ts**

Exports:
- `format(result: ReviewResult, fmt: OutputFormat): string` — dispatcher
- `formatNdjsonChunk(chunk: StreamChunk): string` — single-line JSON + newline
- `detectHighSeverity(content: string): boolean` — regex `/### HIGH|\\[HIGH\\]/`

Internal:
- `formatMarkdown(result)` — header + verbatim content + footer
- `formatText(result)` — strip markdown: `#+ ` → plain, ``` blocks → 4-space indent, `**text**` → text
- `formatJson(result)` — structured JSON with nested `review`, flattened `diff`, `exitCode` from `detectHighSeverity()`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: All formatter tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/formatter.ts test/lib/formatter.test.ts
git commit -m "feat: output formatter with markdown, text, JSON, NDJSON"
```
