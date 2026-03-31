# Multi-Provider Support & Chunked Review — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the review pipeline behind a provider abstraction (Copilot first), add a status command, add map-reduce chunked review for large diffs, then add Ollama as a second provider.

**Architecture:** Extract `ReviewProvider` interface from existing `CopilotClient` + `ModelManager`. Provider factory creates providers from config. Review pipeline accepts a `ReviewProvider` instead of concrete classes. Chunking is a layer in the review orchestrator.

**Tech Stack:** TypeScript, Node.js >= 18, vitest, msw, commander

**Spec:** `docs/spec/15-multi-provider-and-chunked-review.md`

**Phasing:** Copilot → Status → Chunking → Ollama

---

## Phase 1: Provider Abstraction with Copilot

### Task 1: ReviewProvider Interface + Types

**Files:**
- Create: `src/lib/providers/types.ts`
- Modify: `src/lib/types.ts`
- Test: `test/lib/providers/types.test.ts`

- [ ] **Step 1: Create providers directory**

Run: `mkdir -p src/lib/providers test/lib/providers`

- [ ] **Step 2: Write the test for new config types**

```typescript
// test/lib/providers/types.test.ts
import { describe, it, expect } from "vitest";

describe("Provider types", () => {
  it("ReviewProvider interface is importable", async () => {
    const { ReviewProvider } = await import("../../../src/lib/providers/types.js");
    // Interface — no runtime value, just verify the module loads
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/lib/providers/types.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Create providers/types.ts with ReviewProvider interface**

```typescript
// src/lib/providers/types.ts
import type {
  ChatRequest,
  ChatResponse,
  StreamChunk,
  ModelInfo,
} from "../types.js";

export interface ReviewProvider {
  readonly name: string;
  initialize(): Promise<void>;
  chat(request: ChatRequest): Promise<ChatResponse>;
  chatStream(request: ChatRequest): AsyncIterable<StreamChunk>;
  listModels(): Promise<ModelInfo[]>;
  validateModel(id: string): Promise<ModelInfo>;
  autoSelect?(): Promise<string>;
  dispose(): void;
  healthCheck(): Promise<{ ok: boolean; latencyMs: number | null; error?: string }>;
}
```

See spec Section 1 for full JSDoc contracts.

- [ ] **Step 5: Add new config fields to types.ts**

Add to `ConfigFile`:
```typescript
provider?: string;
providerOptions?: {
  ollama?: { baseUrl?: string };
  [key: string]: Record<string, unknown> | undefined;
};
chunking?: "auto" | "always" | "never";
```

Add to `ResolvedConfig`:
```typescript
provider: string;
providerOptions: {
  ollama?: { baseUrl: string };
  [key: string]: Record<string, unknown> | undefined;
};
chunking: "auto" | "always" | "never";
```

Add to `CLIOverrides`:
```typescript
provider?: string;
chunking?: "auto" | "always" | "never";
ollamaUrl?: string;
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/lib/providers/types.test.ts`
Expected: PASS

- [ ] **Step 7: Run full test suite to verify no regressions**

Run: `npx vitest run`
Expected: All existing tests pass

- [ ] **Step 8: Commit**

```bash
git add src/lib/providers/ test/lib/providers/ src/lib/types.ts
git commit -m "feat: add ReviewProvider interface and new config types"
```

---

### Task 2: OpenAIChatProvider Base Class

**Files:**
- Create: `src/lib/providers/openai-chat-provider.ts`
- Test: `test/lib/providers/openai-chat-provider.test.ts`

This task extracts the shared `/chat/completions` protocol from `client.ts` into the abstract base class. The existing `client.ts` remains untouched — we're building the new structure alongside it.

- [ ] **Step 1: Write tests for base class via a TestProvider subclass**

Create `test/lib/providers/openai-chat-provider.test.ts` using `msw` to mock HTTP. Create a minimal `TestProvider extends OpenAIChatProvider` that implements the abstract methods (`getHeaders`, `listModels`). Test:
- `chat()` sends correct body to `${baseUrl}/chat/completions`
- `chat()` parses ChatCompletions response correctly
- `chatStream()` parses SSE stream correctly
- `validateModel()` finds model in list, throws ModelError if missing
- `retry()` retries on 429, 503, 504; does not retry on 401, 400
- `shouldRetry()` default behavior

Use existing fixtures from `test/fixtures/responses/`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/lib/providers/openai-chat-provider.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement OpenAIChatProvider**

Create `src/lib/providers/openai-chat-provider.ts`. Port the following from `client.ts`:
- `_buildChatCompletionsBody()` → `buildRequestBody()` (protected)
- `_parseChatCompletionsResponse()` → `parseResponse()` (protected)
- `_handleErrorResponse()` → `handleErrorResponse()` (protected)
- `_retry()` → `retry()` (protected)
- `_shouldRetry()` → `shouldRetry()` (protected, overridable)
- `_calculateBackoff()` → `calculateBackoff()` (protected)
- `chat()` — uses `${this.baseUrl}/chat/completions`
- `chatStream()` — same, with SSE parsing via existing `streaming.ts`
- `validateModel()` — shared impl: `listModels()` → find → throw
- `initialize()` — default no-op (subclasses override)
- `dispose()` — default no-op
- `healthCheck()` — default impl: GET `${baseUrl}` with 5s timeout

Import `parseSSEStream`, `parseChatCompletionChunk` from `../streaming.js`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/lib/providers/openai-chat-provider.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/providers/openai-chat-provider.ts test/lib/providers/openai-chat-provider.test.ts
git commit -m "feat: add OpenAIChatProvider base class"
```

---

### Task 3: CopilotProvider

**Files:**
- Create: `src/lib/providers/copilot-provider.ts`
- Test: `test/lib/providers/copilot-provider.test.ts`

Merges `client.ts` Copilot-specific logic + `models.ts` into a single provider.

- [ ] **Step 1: Write tests for CopilotProvider**

Test the Copilot-specific behaviors that aren't in the base class:
- `getHeaders()` returns Copilot-specific headers (Editor-Version, Copilot-Integration-Id, etc.)
- `chat()` routes to `/responses` when model endpoints include it, falls back to `/chat/completions`
- `listModels()` — filters, deduplicates, enables policies (port tests from `models.test.ts`)
- `autoSelect()` — calls `/models/session` (port tests from `models.test.ts`)
- `initialize()` — validates auth token (exchanges session token)
- `dispose()` — zeros session token
- `healthCheck()` — GET `/models`

Use `msw` with `api.githubcopilot.com` handlers.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/lib/providers/copilot-provider.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement CopilotProvider**

Create `src/lib/providers/copilot-provider.ts`. This class:
- Extends `OpenAIChatProvider`
- Constructor takes `AuthProvider`, calls `super("https://api.githubcopilot.com")`
- Overrides `chat()`/`chatStream()` to support Responses API routing
- Implements `listModels()` by porting from `models.ts` (filter, dedup, policy enable, cache)
- Implements `autoSelect()` by porting from `models.ts`
- Implements `getHeaders()` using `this.auth.getAuthenticatedHeaders()` + Copilot headers
- Implements `initialize()` — calls `getHeaders()` once to validate auth
- Implements `dispose()` — zeros cached session token
- Implements `healthCheck()` — GET `/models` with 5s timeout

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/lib/providers/copilot-provider.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/providers/copilot-provider.ts test/lib/providers/copilot-provider.test.ts
git commit -m "feat: add CopilotProvider (merges client + models)"
```

---

### Task 4: Provider Factory

**Files:**
- Create: `src/lib/providers/index.ts`
- Test: `test/lib/providers/index.test.ts`

- [ ] **Step 1: Write tests for factory**

Test:
- `createProvider({ provider: "copilot", ... })` returns `CopilotProvider`
- `createProvider({ provider: "unknown", ... })` throws `ConfigError("unknown_provider")` listing available providers
- `availableProviders()` returns `["copilot"]` (Ollama added later)
- Provider construction failure wraps error with context

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/lib/providers/index.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement factory**

Create `src/lib/providers/index.ts` per spec Section 2 (Provider Factory). Registry pattern with `PROVIDERS` map. `createProvider` is async — calls `provider.initialize()`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/lib/providers/index.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/providers/index.ts test/lib/providers/index.test.ts
git commit -m "feat: add provider factory with registry pattern"
```

---

### Task 5: Update Config for Provider + Env Vars + New Paths

**Files:**
- Modify: `src/lib/config.ts`
- Modify: `test/lib/config.test.ts`

- [ ] **Step 1: Write tests for new config behavior**

Add tests to `config.test.ts`:
- Default config has `provider: "copilot"`, `chunking: "auto"`, `providerOptions: {}`
- `LLM_REVIEWER_PROVIDER=ollama` overrides provider
- `LLM_REVIEWER_OLLAMA_URL=http://remote:11434` overrides providerOptions.ollama.baseUrl
- `LLM_REVIEWER_CHUNKING=never` overrides chunking
- Invalid `LLM_REVIEWER_OLLAMA_URL` throws ConfigError at load time
- New config path `~/.llm-reviewer/` preferred over `~/.llm-reviewer/`
- Fallback: if new path missing, old path used silently
- Both paths exist: warning emitted, new path wins
- providerOptions: shallow merge per provider key
- Unknown providerOptions key: warning with Levenshtein suggestion
- CLI overrides: `--provider`, `--chunking`, `--ollama-url`

- [ ] **Step 2: Run tests to verify new tests fail**

Run: `npx vitest run test/lib/config.test.ts`
Expected: New tests FAIL, existing tests PASS

- [ ] **Step 3: Implement config changes**

Update `src/lib/config.ts`:
- Add `provider`, `chunking`, `providerOptions` to built-in defaults
- Add env var reading layer between defaults and global config
- Update `loadConfigLayer()` to handle new fields
- Update `mergeConfig()` for providerOptions (shallow merge per key)
- Update path detection: try `~/.llm-reviewer/` first, fallback to `~/.llm-reviewer/`
- Same for project path: `<git-root>/.llm-reviewer/` then `.llm-reviewer/`
- URL validation for providerOptions.ollama.baseUrl
- Unknown providerOptions key warning (Levenshtein)
- Both-paths-exist warning

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/lib/config.test.ts`
Expected: PASS (all)

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add src/lib/config.ts test/lib/config.test.ts
git commit -m "feat: add provider/chunking config, env vars, new config paths"
```

---

### Task 6: Update Review Pipeline to Use ReviewProvider

**Files:**
- Modify: `src/lib/review.ts`
- Modify: `test/lib/review.test.ts`

- [ ] **Step 1: Write tests with MockProvider**

Create a `MockProvider` in the test file (per spec Section 8). Update existing review tests to use `MockProvider` instead of `CopilotClient` + `ModelManager`. The test behavior should be identical — same inputs, same outputs. Add new test:
- `review()` accepts `ReviewProvider` and calls `provider.chat()`
- `reviewStream()` accepts `ReviewProvider` and calls `provider.chatStream()`
- Model resolution uses `provider.autoSelect()` and `provider.validateModel()`

- [ ] **Step 2: Run tests to verify new tests fail (signature mismatch)**

Run: `npx vitest run test/lib/review.test.ts`
Expected: New tests FAIL (old signature)

- [ ] **Step 3: Update review.ts signature**

Change:
```typescript
// Before
export async function review(options, client: CopilotClient, models: ModelManager)
// After
export async function review(options, provider: ReviewProvider)
```

Update `resolveModel()` to use `provider.autoSelect()` / `provider.validateModel()`.
Update API call to use `provider.chat()` / `provider.chatStream()`.
Remove `useResponsesApi` logic — now internal to CopilotProvider.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/lib/review.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/review.ts test/lib/review.test.ts
git commit -m "refactor: review pipeline uses ReviewProvider instead of client+models"
```

---

### Task 7: Update CLI + MCP Server + Exports

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/mcp-server.ts`
- Modify: `src/lib/index.ts`
- Modify: `test/cli.test.ts` (if exists)
- Modify: `test/mcp-server.test.ts` (if exists)

- [ ] **Step 1: Update cli.ts**

Replace:
```typescript
const auth = createDefaultAuthProvider();
const client = new CopilotClient(auth);
const models = new ModelManager(auth);
```
With:
```typescript
const provider = await createProvider(config);
```

Update `handleReview()`, `handleModels()`, `handleChat()` to use `provider`.
Add `--provider`, `--chunking`, `--ollama-url` CLI flags.
Add `process.on("exit", () => provider.dispose())` for cleanup.

- [ ] **Step 2: Update mcp-server.ts**

Replace singleton `_client`/`_models` with singleton `_provider`.
Update `getClient()`/`getModelManager()` → `getProvider()`.
Update all handlers to use `provider`.

- [ ] **Step 3: Update index.ts exports**

Remove: `CopilotClient`, `ModelManager` exports.
Add: `createProvider`, `availableProviders`, `ReviewProvider` type export.

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All pass. If existing tests import `CopilotClient`/`ModelManager` directly, update them.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/mcp-server.ts src/lib/index.ts
git commit -m "refactor: cli + mcp-server use createProvider()"
```

---

### Task 8: Delete client.ts + models.ts

**Files:**
- Delete: `src/lib/client.ts`
- Delete: `src/lib/models.ts`
- Delete: `test/lib/client.test.ts`
- Delete: `test/lib/models.test.ts`

- [ ] **Step 1: Verify no remaining imports**

Run: `grep -r "from.*client\.js" src/ test/ --include="*.ts" | grep -v providers`
Run: `grep -r "from.*models\.js" src/ test/ --include="*.ts" | grep -v providers`
Expected: No results (or only in the files being deleted)

- [ ] **Step 2: Delete files**

```bash
rm src/lib/client.ts src/lib/models.ts
rm test/lib/client.test.ts test/lib/models.test.ts
```

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: remove client.ts + models.ts (absorbed into providers)"
```

---

## Phase 2: Status Command

### Task 9: Status Command Handler

**Files:**
- Modify: `src/cli.ts`
- Test: `test/cli.test.ts` or inline

- [ ] **Step 1: Write tests for handleStatus**

Test:
- Returns exit 0 when provider healthy, auth valid, model resolved
- Returns exit 1 when provider unreachable
- Returns exit 1 when model required but not set (Ollama + auto)
- `--json` flag outputs valid JSON matching `StatusOutput` schema
- Shows config file paths (found/not-found/fallback)
- Shows resolved model for `model: auto`

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement handleStatus**

Add `handleStatus(opts)` to `cli.ts`. Logic:
1. Load config
2. Create provider (catch errors → exit 1)
3. Call `provider.healthCheck()`
4. If `model: auto` and `provider.autoSelect`, resolve model
5. If `provider.listModels()`, get model list
6. Format output (text or JSON based on `--json`)
7. Return exit code (0 if all healthy, 1 if any failure)

Add `status` subcommand to `buildProgram()`.

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/
git commit -m "feat: add 'llm-reviewer status' command"
```

---

## Phase 3: Chunked Review

### Task 10: Diff Splitting + Bin-Packing

**Files:**
- Create: `src/lib/chunking.ts`
- Test: `test/lib/chunking.test.ts`

This is the core chunking algorithm — pure functions, no provider dependency.

- [ ] **Step 1: Write tests for splitDiffByFile**

Test `splitDiffByFile(rawDiff)`:
- Standard multi-file diff → correct per-file segments
- Single file diff → one segment
- Added file (`-0,0 +1,N`) → parsed correctly
- Deleted file (`-N +0,0`) → parsed correctly
- No `diff --git` boundary → entire diff as single "unknown" segment
- Binary file → excluded with warning
- Malformed hunk header → included in segment, warning emitted

- [ ] **Step 2: Write tests for binPackFiles**

Test `binPackFiles(fileSegments, chunkBudget)`:
- All files fit → 1 chunk
- 10 files need 3 chunks → correct split
- Files sorted largest-first (verify order)
- Equal-size files tie-break alphabetically
- Single file exceeds budget → triggers hunk split
- maxPromptTokens <= 0 → throws ReviewError
- chunkBudget <= 0 → throws ReviewError

- [ ] **Step 3: Write tests for splitFileByHunks**

Test `splitFileByHunks(fileSegment, chunkBudget)`:
- Multiple hunks → bin-packed into chunks
- Single hunk exceeds budget → truncated at newline boundary
- No newline within 1000 chars → truncated at limit
- Zero parseable hunks → treated as single hunk

- [ ] **Step 4: Run all chunking tests to verify they fail**

Run: `npx vitest run test/lib/chunking.test.ts`
Expected: FAIL

- [ ] **Step 5: Implement splitDiffByFile**

Parse by `diff --git a/ b/` boundaries. Extract file path, raw segment. Detect binary files. Handle malformed hunks gracefully.

- [ ] **Step 6: Run splitDiffByFile tests**

Expected: PASS

- [ ] **Step 7: Implement binPackFiles**

FFD algorithm per spec. Sort by estimated tokens (desc), tie-break alphabetical. Strict `<` for fits check. Guard for invalid budget.

- [ ] **Step 8: Run binPackFiles tests**

Expected: PASS

- [ ] **Step 9: Implement splitFileByHunks**

Split by `@@` headers. Truncation with newline snap. Truncation marker appended.

- [ ] **Step 10: Run all chunking tests**

Run: `npx vitest run test/lib/chunking.test.ts`
Expected: ALL PASS

- [ ] **Step 11: Commit**

```bash
git add src/lib/chunking.ts test/lib/chunking.test.ts
git commit -m "feat: add diff splitting and bin-packing for chunked review"
```

---

### Task 11: Chunk + Reduce Prompt Assembly

**Files:**
- Modify: `src/lib/prompt.ts`
- Modify: `test/lib/prompt.test.ts`

- [ ] **Step 1: Write tests for new prompt functions**

Test `assembleChunkMessage(chunkIndex, totalChunks, files, diffSegment)`:
- Includes "Review chunk {i} of {n}"
- Includes file list
- Includes diff in code fence

Test `assembleReduceMessage(chunkFindings, allFiles)`:
- Includes all chunk findings with headers
- Includes full file manifest at end
- Includes cross-file analysis instruction

Test `assembleFileManifest(files, hunkRanges)`:
- Markdown table with file, status, line ranges

Test `getReduceSystemPrompt()`:
- Returns the aggregation prompt

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement prompt functions**

Add to `prompt.ts`:
- `assembleChunkMessage()` — per spec Phase 1 MAP format
- `assembleReduceMessage()` — per spec Phase 2 REDUCE format
- `assembleFileManifest()` — markdown table from hunk headers
- `getReduceSystemPrompt()` — aggregation instructions per spec

Also update `assembleUserMessage()` to include file manifest (line ranges from hunks).

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add src/lib/prompt.ts test/lib/prompt.test.ts
git commit -m "feat: add chunk/reduce prompt assembly and file manifest"
```

---

### Task 12: Severity-Aware Truncation

**Files:**
- Create: `src/lib/truncation.ts`
- Test: `test/lib/truncation.test.ts`

- [ ] **Step 1: Write tests for severity parsing**

Test `parseSeverityTiers(findingsText)`:
- `### HIGH` → Tier 1
- `[MEDIUM]` → Tier 2
- `**LOW**` → Tier 3
- Case-insensitive: `### high` → Tier 1
- Mixed formats in same text
- No markers → all Tier 2
- Preamble before first marker → Tier 2
- Start-of-line only (mid-line `[HIGH]` not matched)

- [ ] **Step 2: Write tests for truncateForReduce**

Test `truncateForReduce(chunkFindings[], budget)`:
- All fit → returned unchanged
- Round 1: LOW removed, replaced with `[N LOW findings omitted]`
- Round 2: MEDIUM title + first paragraph kept
- Round 3: MEDIUM title only
- Round 4: proportional truncation
- HIGH never truncated (unless pathological)
- Returns truncation warnings

- [ ] **Step 3: Run tests to verify they fail**

- [ ] **Step 4: Implement severity parsing + truncation**

- [ ] **Step 5: Run tests to verify they pass**

- [ ] **Step 6: Commit**

```bash
git add src/lib/truncation.ts test/lib/truncation.test.ts
git commit -m "feat: add severity-aware truncation for reduce pass"
```

---

### Task 13: Map-Reduce Review Pipeline

**Files:**
- Modify: `src/lib/review.ts`
- Modify: `test/lib/review.test.ts`

- [ ] **Step 1: Write tests for chunked review routing**

Test with `MockProvider` (configurable `maxPromptTokens`):
- Small diff + `chunking: "auto"` → single pass (no chunking)
- Large diff + `chunking: "auto"` → chunks created, map-reduce called
- Any diff + `chunking: "always"` → always chunks
- Any diff + `chunking: "never"` → throws ReviewError if too large
- 1 chunk → reduce skipped
- 3 chunks → 3 map calls + 1 reduce call
- Token accounting: usage = sum of all calls
- Progress callback called between chunks
- Reduce failure → fallback to raw chunk findings with warning

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement shouldChunk() decision function**

In `review.ts`, add:
```typescript
function shouldChunk(config: ResolvedConfig, diff: DiffResult, modelInfo: ModelInfo): boolean
```

- [ ] **Step 4: Implement chunkedReview()**

Add `chunkedReview()` function:
1. Call `splitDiffByFile()` + `binPackFiles()`
2. Sequential map: for each chunk, call `provider.chat()` with chunk message
3. If 1 chunk: return directly (skip reduce)
4. Assemble reduce input with `assembleReduceMessage()`
5. Check reduce budget, truncate if needed
6. Call `provider.chat()` for reduce
7. Catch reduce failure → fallback to concatenated raw findings
8. Return `ChunkedReviewResult`

- [ ] **Step 5: Update review() to route to chunkedReview()**

```typescript
export async function review(options, provider) {
  // ... resolve model, collect diff ...
  if (shouldChunk(config, diff, modelInfo)) {
    return chunkedReview(diff, modelInfo, options, provider);
  }
  return singlePassReview(diff, modelInfo, options, provider);
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/lib/review.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/lib/review.ts test/lib/review.test.ts
git commit -m "feat: add map-reduce chunked review pipeline"
```

---

### Task 14: Formatter Updates for Chunked Output

**Files:**
- Modify: `src/lib/formatter.ts`
- Modify: `test/lib/formatter.test.ts`

- [ ] **Step 1: Write tests**

- Chunked markdown: header includes "Chunks: N"
- Chunked JSON: includes `chunkedBreakdown` in usage
- Single-pass: no chunk metadata (unchanged)
- Unaggregated fallback: header includes "(unaggregated)"

- [ ] **Step 2: Run tests to verify new tests fail**

- [ ] **Step 3: Implement formatter changes**

Update `formatMarkdown()`, `formatText()`, `formatJson()` to detect `ChunkedReviewResult` (check `chunked: true` discriminant) and include chunk metadata.

- [ ] **Step 4: Run tests**

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/formatter.ts test/lib/formatter.test.ts
git commit -m "feat: formatter shows chunk metadata for chunked reviews"
```

---

### Task 15: Streaming with Chunked Review

**Files:**
- Modify: `src/lib/review.ts`
- Modify: `test/lib/review.test.ts`

- [ ] **Step 1: Write tests for chunked streaming**

- `reviewStream()` with chunking: map phase buffered, reduce phase streamed
- Progress markers emitted via callback (not mixed into stream)
- Single chunk: stream directly (no reduce)

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement chunked streaming in reviewStream()**

Update `reviewStream()` to handle chunking:
- Map phase: use `provider.chat()` (buffered)
- Emit progress between chunks via stderr callback
- Reduce phase: use `provider.chatStream()` for the AsyncIterable

- [ ] **Step 4: Run tests**

Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/review.ts test/lib/review.test.ts
git commit -m "feat: streaming support for chunked review (buffered map, streamed reduce)"
```

---

## Phase 4: Ollama Provider

### Task 16: OllamaProvider

**Files:**
- Create: `src/lib/providers/ollama-provider.ts`
- Test: `test/lib/providers/ollama-provider.test.ts`

- [ ] **Step 1: Write tests**

Using `msw` mocking `localhost:11434`:
- `getHeaders()` returns Content-Type only (no auth)
- `listModels()` parses `/api/tags` response into `ModelInfo[]`
- `listModels()` calls `/api/show` per model for context length
- `listModels()` falls back to 4096 if /api/show fails for a model
- `listModels()` throws ClientError if /api/tags fails entirely
- `listModels()` returns `[]` if no models installed
- `listModels()` caches for 5 minutes
- `initialize()` checks reachability (GET /api/tags)
- `healthCheck()` returns latency
- URL validation: rejects paths, query strings
- `shouldRetry()` retries ECONNREFUSED
- `chat()` / `chatStream()` inherited — uses `/v1/chat/completions`

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement OllamaProvider**

Create `src/lib/providers/ollama-provider.ts` per spec.

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add src/lib/providers/ollama-provider.ts test/lib/providers/ollama-provider.test.ts
git commit -m "feat: add OllamaProvider for local LLM code review"
```

---

### Task 17: Register Ollama in Factory

**Files:**
- Modify: `src/lib/providers/index.ts`
- Modify: `test/lib/providers/index.test.ts`

- [ ] **Step 1: Add tests**

- `createProvider({ provider: "ollama", ... })` returns `OllamaProvider`
- `createProvider({ provider: "ollama", providerOptions: { ollama: { baseUrl: "http://custom:1234" } } })` uses custom URL
- Default URL is `http://localhost:11434`
- `availableProviders()` returns `["copilot", "ollama"]`

- [ ] **Step 2: Run tests to verify new tests fail**

- [ ] **Step 3: Add ollama to PROVIDERS registry**

- [ ] **Step 4: Run tests**

Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/providers/index.ts test/lib/providers/index.test.ts
git commit -m "feat: register OllamaProvider in factory"
```

---

### Task 18: Update Exports + Final Integration Test

**Files:**
- Modify: `src/lib/index.ts`
- Modify: `test/lib/exports.test.ts`

- [ ] **Step 1: Update exports**

Add to `index.ts`:
- `export { createProvider, availableProviders } from "./providers/index.js"`
- `export type { ReviewProvider } from "./providers/types.js"`
- `export { OllamaProvider } from "./providers/ollama-provider.js"`
- `export { CopilotProvider } from "./providers/copilot-provider.js"`

- [ ] **Step 2: Update exports test**

Verify all new exports are accessible.

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: Clean TypeScript compilation

- [ ] **Step 5: Commit**

```bash
git add src/lib/index.ts test/lib/exports.test.ts
git commit -m "feat: export provider types and factory from public API"
```

---

## Task Index

| # | Phase | Task | Key Files | Dependencies |
|---|-------|------|-----------|--------------|
| 1 | 1 | ReviewProvider Interface + Types | `providers/types.ts`, `types.ts` | None |
| 2 | 1 | OpenAIChatProvider Base Class | `providers/openai-chat-provider.ts` | Task 1 |
| 3 | 1 | CopilotProvider | `providers/copilot-provider.ts` | Task 2 |
| 4 | 1 | Provider Factory | `providers/index.ts` | Task 3 |
| 5 | 1 | Config Updates | `config.ts` | Task 1 |
| 6 | 1 | Review Pipeline Update | `review.ts` | Tasks 4, 5 |
| 7 | 1 | CLI + MCP + Exports Update | `cli.ts`, `mcp-server.ts`, `index.ts` | Task 6 |
| 8 | 1 | Delete client.ts + models.ts | — | Task 7 |
| 9 | 2 | Status Command | `cli.ts` | Task 7 |
| 10 | 3 | Diff Splitting + Bin-Packing | `chunking.ts` | Task 1 |
| 11 | 3 | Chunk + Reduce Prompts | `prompt.ts` | Task 10 |
| 12 | 3 | Severity-Aware Truncation | `truncation.ts` | None |
| 13 | 3 | Map-Reduce Pipeline | `review.ts` | Tasks 10, 11, 12 |
| 14 | 3 | Formatter Updates | `formatter.ts` | Task 13 |
| 15 | 3 | Streaming with Chunks | `review.ts` | Task 13 |
| 16 | 4 | OllamaProvider | `providers/ollama-provider.ts` | Task 2 |
| 17 | 4 | Register Ollama in Factory | `providers/index.ts` | Task 16 |
| 18 | 4 | Final Exports + Integration | `index.ts` | Task 17 |
