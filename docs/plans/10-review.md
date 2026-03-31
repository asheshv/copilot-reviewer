# Task 10: Review Orchestration

[Back to Plan Index](./README.md) | Prev: [09 — Formatter](./09-formatter.md) | Next: [11 — Exports](./11-exports.md)

**Dependencies:** Tasks 5 (client), 6 (models), 7 (diff), 8 (config+prompt), 9 (formatter)
**Spec ref:** [07 — Review Orchestration](../spec/07-review-orchestration.md)

**Files:**
- Create: `src/lib/review.ts`
- Test: `test/lib/review.test.ts`

---

- [ ] **Step 1: Write failing tests**

```typescript
describe("review()", () => {
  it("executes full pipeline: diff -> model -> budget -> assemble -> call -> format");
  it("returns ReviewResult with content, model, usage, diff, warnings");

  describe("empty diff", () => {
    it("returns early with no-changes result without calling API");
  });

  describe("model resolution", () => {
    it("auto mode: calls autoSelect() then validateModel() to get ModelInfo");
    it("explicit mode: calls validateModel() directly");
  });

  describe("token budget", () => {
    it("estimate < 80% of maxPromptTokens: no warning");
    it("estimate >= 80% and < 100%: adds warning to result");
    it("estimate >= 100%: throws ReviewError diff_too_large");
  });

  describe("message assembly", () => {
    it("system message is config.prompt (single concatenated string)");
    it("user message formatted via assembleUserMessage()");
  });

  describe("ignorePaths", () => {
    it("passes config.ignorePaths to DiffOptions");
  });

  describe("empty response", () => {
    it("returns exit code 0 with 'no findings' warning");
  });
});

describe("reviewStream()", () => {
  it("returns tuple { stream, warnings, diff, model }");
  it("warnings computed before stream starts");
  it("stream yields string chunks from client.chatStream()");
  it("model is resolved model ID");
  it("diff is DiffResult metadata");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL.

- [ ] **Step 3: Implement review.ts**

Two exports:
- `review(options: ReviewOptions): Promise<ReviewResult>` — buffered path
- `reviewStream(options: ReviewOptions): Promise<ReviewStreamResult>` — streaming path

Implementation follows spec 07 pipeline:

```
1. collectDiff(options.diff)  // with ignorePaths from config
2. resolveModel(options.model, config.model)  // auto or explicit → ModelInfo
3. checkTokenBudget(prompt, diff, modelInfo)  // warn at 80%, fail at 100%
4. assembleMessages(config.prompt, diff)  // system + user
5. client.chat(request) or client.chatStream(request)
6. format(response, config.format)  // buffered path only
```

Dependencies are passed as parameters for testability:

```typescript
export async function review(
  options: ReviewOptions,
  client: CopilotClient,
  models: ModelManager,
): Promise<ReviewResult> { ... }

export async function reviewStream(
  options: ReviewOptions,
  client: CopilotClient,
  models: ModelManager,
): Promise<ReviewStreamResult> { ... }
```

CLI and MCP server construct `CopilotClient` + `ModelManager` and pass them in. Tests can pass mocks.

### Logging

When `options.config` includes a verbose flag (or `DEBUG=llm-reviewer` env var is set), log to stderr:
- Resolved config (tokens redacted)
- Auth token source and expiry
- API request URL, method, headers (Authorization redacted)
- Response status code and rate limit headers
- Git commands executed

Use a simple `debug(msg: string)` helper that checks the verbose/DEBUG flag and writes to `process.stderr`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: All review tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/review.ts test/lib/review.test.ts
git commit -m "feat: review orchestration pipeline with budget checking and streaming"
```
