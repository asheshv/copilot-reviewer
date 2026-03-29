# 15 — Multi-Provider Support & Chunked Review

[Back to Spec Index](./README.md) | Previous: [14 — Future](./14-future.md)

---

## Overview

This spec introduces two related capabilities:

1. **Multi-provider support** — pluggable review providers (Copilot, Ollama, future LLMs) behind a common interface.
2. **Chunked review** — automatic diff splitting with map-reduce aggregation for large diffs that exceed model context limits.

## Goals

- Open-ended provider abstraction — new providers require only code additions, no architectural changes.
- Ollama as the first non-Copilot provider, enabling fully local code review.
- Transparent chunking that kicks in automatically when diffs are too large.
- Provider selection configurable via CLI, config file, and environment variable.

## Non-Goals

- Runtime plugin loading (file-based or npm-based) — built-in providers only for now.
- Independently configurable model for the reduce (aggregation) pass — deferred to a future enhancement.
- Renaming the project from `copilot-review` — cosmetic, deferred.

---

## 1. Provider Interface

The core abstraction. Every provider implements this interface.

```typescript
// src/lib/providers/types.ts

export interface ReviewProvider {
  readonly name: string;

  /** Non-streaming chat completion */
  chat(request: ChatRequest): Promise<ChatResponse>;

  /** Streaming chat completion */
  chatStream(request: ChatRequest): AsyncIterable<StreamChunk>;

  /** List available models on this provider */
  listModels(): Promise<ModelInfo[]>;

  /** Validate a model ID exists on this provider */
  validateModel(id: string): Promise<ModelInfo>;

  /** Auto-select best model (optional — not all providers support this) */
  autoSelect?(): Promise<string>;

  /**
   * Health check — verify provider is reachable. Returns latency in ms.
   * Called only by the `status` command, never during normal review flow
   * (review errors surface through chat/chatStream naturally).
   * Implementations should use the lightest possible request:
   *   - Copilot: GET /models (already needed for validation)
   *   - Ollama: GET /api/tags (lightweight, returns quickly)
   */
  healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }>;
}
```

Key decisions:

- `chat` and `chatStream` use the existing `ChatRequest` / `ChatResponse` / `StreamChunk` types unchanged — they are already provider-agnostic.
- `listModels` and `validateModel` move into the provider. Currently split across `CopilotClient` + `ModelManager`, they merge into a single provider object.
- `autoSelect` is optional — Copilot has this endpoint, most others do not.
- The `useResponsesApi` boolean currently threaded through client code becomes an internal Copilot implementation detail, hidden behind the interface.

---

## 2. Class Hierarchy

```
ReviewProvider (interface)
  ├── OpenAIChatProvider (abstract base class — shared OpenAI-compatible protocol)
  │     ├── CopilotProvider (Copilot auth, session exchange, Responses API, auto-select)
  │     └── OllamaProvider (no auth, localhost default, /api/tags discovery)
  └── (future: AnthropicProvider, etc. — implement ReviewProvider directly, not via OpenAIChatProvider.
  │    These providers use non-OpenAI protocols and need their own request/response mapping.
  │    The ReviewProvider interface is deliberately protocol-agnostic to support this.)
```

### OpenAIChatProvider (base class)

Handles the common `/chat/completions` protocol shared by Copilot, Ollama, OpenAI, OpenRouter, and others.

```typescript
// src/lib/providers/openai-chat-provider.ts

export abstract class OpenAIChatProvider implements ReviewProvider {
  abstract readonly name: string;

  constructor(protected baseUrl: string) {}

  /** Subclasses provide auth headers (or empty for no-auth providers like Ollama) */
  protected abstract getHeaders(): Promise<Record<string, string>>;

  /** Subclasses provide model discovery */
  abstract listModels(): Promise<ModelInfo[]>;

  // Shared implementations:

  async chat(request: ChatRequest): Promise<ChatResponse> {
    // POST to ${baseUrl}/chat/completions
    // Reuses existing request body construction, retry, error handling
  }

  async *chatStream(request: ChatRequest): AsyncIterable<StreamChunk> {
    // Streaming variant, reuses existing SSE parser
  }

  async validateModel(id: string): Promise<ModelInfo> {
    // Shared: listModels() → find by id → throw ModelError if missing
  }
}
```

Retry logic lives in the base class with a `shouldRetry(error)` method that subclasses can override for provider-specific behavior.

### CopilotProvider

```typescript
// src/lib/providers/copilot-provider.ts

export class CopilotProvider extends OpenAIChatProvider {
  readonly name = "copilot";

  constructor(auth: AuthProvider) {
    super("https://api.githubcopilot.com");
  }

  // Overrides chat/chatStream to support Responses API
  // (routes based on model endpoint metadata, same as current code)
  // Fallback: if Responses API returns 4xx, falls back to /chat/completions
  // (same model, same request — only the body format changes)

  // listModels() — current ModelManager logic (filter, dedup, policy enable)
  // autoSelect() — current /models/session logic
  // getHeaders() — Copilot-specific headers + session token exchange
}
```

### OllamaProvider

```typescript
// src/lib/providers/ollama-provider.ts

export class OllamaProvider extends OpenAIChatProvider {
  readonly name = "ollama";

  constructor(baseUrl = "http://localhost:11434") {
    super(baseUrl);
  }

  // getHeaders() — empty auth, Content-Type only
  // listModels() — GET /api/tags → transform to ModelInfo[]
  // No autoSelect — user must pick a model
  // chat/chatStream inherited — Ollama speaks /v1/chat/completions
}
```

**URL validation:** The `OllamaProvider` constructor normalizes and validates the base URL:
- Validate it parses as a URL (`new URL(baseUrl)` — throws `ConfigError` if invalid)
- Strip trailing slashes (`http://localhost:11434/` → `http://localhost:11434`)
- **Reject non-root paths** — if `parsed.pathname` is anything other than `/`, throw `ConfigError`: "Ollama base URL must not include a path (got '{pathname}'). Use the root URL, e.g., http://localhost:11434". This prevents common mistakes like passing `http://localhost:11434/v1` (the provider appends `/v1/chat/completions` internally).

```typescript
// In OllamaProvider constructor:
const parsed = new URL(baseUrl);
if (parsed.pathname !== "/" && parsed.pathname !== "") {
  throw new ConfigError("invalid_url",
    `Ollama base URL must not include a path (got '${parsed.pathname}'). Use the root URL, e.g., http://localhost:11434`,
    baseUrl, false);
}
this.baseUrl = `${parsed.protocol}//${parsed.host}`;  // normalized, no trailing path
```

### Provider Factory

Uses a registry pattern so the error message and available provider list stay in sync automatically.

```typescript
// src/lib/providers/index.ts

type ProviderFactory = (config: ResolvedConfig) => ReviewProvider;

const PROVIDERS: Record<string, ProviderFactory> = {
  copilot: (config) => new CopilotProvider(createDefaultAuthProvider()),
  ollama: (config) => {
    const url = config.providerOptions.ollama?.baseUrl
      ?? "http://localhost:11434";
    return new OllamaProvider(url);
  },
};

export function createProvider(config: ResolvedConfig): ReviewProvider {
  const factory = PROVIDERS[config.provider];
  if (!factory) {
    const available = Object.keys(PROVIDERS).join(", ");
    throw new ConfigError(
      "unknown_provider",
      `Unknown provider '${config.provider}'. Available: ${available}`,
      "config",
      false
    );
  }
  return factory(config);
}

/** List registered provider names (used by status command, --help, etc.) */
export function availableProviders(): string[] {
  return Object.keys(PROVIDERS);
}
```

---

## 3. Configuration Changes

### New Config Fields

```typescript
// Additions to ConfigFile
interface ConfigFile {
  // ... existing fields ...
  provider?: string;              // "copilot" | "ollama" | future providers
  providerOptions?: {
    ollama?: {
      baseUrl?: string;           // default: "http://localhost:11434"
    };
    // future providers get their own key here
  };
  chunking?: "auto" | "always" | "never";  // default: "auto"
}
```

```typescript
// Additions to ResolvedConfig
interface ResolvedConfig {
  // ... existing fields ...
  provider: string;
  providerOptions: Record<string, Record<string, unknown>>;
  chunking: "auto" | "always" | "never";
}
```

### Config Directory Rename

New paths:

- **Global**: `~/.code-reviewer/config.json`
- **Project**: `<git-root>/.code-reviewer/config.json`

Backward compatibility: if the new path does not exist, silently fall back to the old path (`~/.copilot-review/`). No warnings emitted. New path takes precedence if both exist.

**Migration risk assessment:** We considered the risk of silent shadowing when both `~/.code-reviewer/` and `~/.copilot-review/` exist. The precedence rule (new path wins) is deterministic, but a user who manually edits the old path after the new one was auto-created could be confused. For v1, we accept this risk — the `status` command will show exactly which config file is loaded, making debugging straightforward. A future migration tool or deprecation warning is out of scope but documented in Section 9.

### Config Merge Order (updated)

```
1. Built-in defaults          provider: "copilot", chunking: "auto"
2. CODEREVIEWER_PROVIDER env  provider override only
3. CODEREVIEWER_OLLAMA_URL    providerOptions.ollama.baseUrl override
4. Global config              ~/.code-reviewer/config.json (fallback: ~/.copilot-review/)
5. Project config             <git-root>/.code-reviewer/config.json (fallback: .copilot-review/)
6. CLI overrides              --provider, --chunking, --ollama-url, --model, etc.
```

Environment variables slot between defaults and config files — config files can override them, CLI always wins.

### CLI Additions

```
--provider <name>       Review provider: copilot, ollama
--chunking <mode>       auto | always | never (default: auto)
--ollama-url <url>      Ollama base URL (shorthand for providerOptions.ollama.baseUrl)
```

The existing `copilot-review models` subcommand becomes provider-aware: `copilot-review models --provider ollama` lists Ollama models. Defaults to the configured provider.

### Status Command

New subcommand: `copilot-review status`

Displays resolved configuration and provider health in a single view. Useful for debugging setup issues and confirming what the tool will use before running a review.

```
$ copilot-review status

  Provider:       copilot
  Model:          auto → gpt-4.1 (auto-selected)
  Chunking:       auto
  Stream:         true
  Format:         markdown
  Config (global): ~/.code-reviewer/config.json (found)
  Config (project): /repo/.code-reviewer/config.json (not found, fallback: .copilot-review/ not found)
  Auth:           GitHub token (gh CLI) ✓
  API reachable:  ✓ (245ms)
```

```
$ copilot-review status --provider ollama

  Provider:       ollama
  Model:          (not set — required, use --model)
  Base URL:       http://localhost:11434
  Chunking:       auto
  Stream:         true
  Format:         markdown
  Config (global): ~/.code-reviewer/config.json (found)
  Config (project): /repo/.code-reviewer/config.json (not found)
  Auth:           none (not required)
  API reachable:  ✓ (12ms)
  Models:         deepseek-coder-v2, codellama:13b, qwen2.5-coder:7b
```

```
$ copilot-review status --provider ollama

  Provider:       ollama
  ...
  API reachable:  ✗ — connection refused at http://localhost:11434
```

Behavior:
- Resolves the full config merge (defaults → env → global → project → CLI) and shows the result.
- Shows which config files were found and which fell back or were missing.
- For `model: auto`, resolves the auto-selection and shows both `auto → <resolved>`.
- Pings the provider's API to confirm reachability (lightweight health check, not a full chat call).
- For Ollama, lists discovered models when reachable.
- Exits with code 0 if everything is healthy, 1 if any check fails (unreachable, missing required model, auth failure).
- Accepts `--json` flag for machine-readable output with this schema:

```typescript
interface StatusOutput {
  provider: string;
  model: {
    configured: string;           // "auto" or explicit model ID
    resolved: string | null;      // actual model ID after auto-select, null if resolution failed
  };
  chunking: "auto" | "always" | "never";
  stream: boolean;
  format: string;
  config: {
    global: { path: string; found: boolean; fallback?: string; fallbackFound?: boolean };
    project: { path: string; found: boolean; fallback?: string; fallbackFound?: boolean };
  };
  auth: {
    method: string;               // "env_token" | "copilot_config" | "gh_cli" | "none"
    valid: boolean;
    error?: string;
  };
  api: {
    reachable: boolean;
    latencyMs: number | null;
    error?: string;
  };
  models: string[] | null;        // discovered model IDs when API reachable, null when unreachable or discovery failed
  healthy: boolean;               // overall: true if all checks pass
}
```

### Review Pipeline Change

```typescript
// Before
const client = new CopilotClient(auth);
const models = new ModelManager(auth);
review(options, client, models);

// After
const provider = createProvider(config);
review(options, provider);
```

---

## 4. Chunked Review (Map-Reduce Pipeline)

### When Chunking Activates

```
chunking = "auto" (default):
  1. Resolve the model first (auto-select or explicit) → get ModelInfo with maxPromptTokens
  2. estimate tokens = (systemPrompt.length + diff.raw.length) / 4
  3. if estimate < 80% of resolved model's maxPromptTokens → single pass (current behavior)
     if estimate >= 80% → chunk and map-reduce

chunking = "always":  → always chunk, even small diffs (still resolves model first for budget)
                         Useful for: testing chunking behavior, or when you want consistent
                         multi-pass review quality regardless of diff size
chunking = "never":   → current behavior, throw ReviewError if diff too large
                         Useful for: CI pipelines where you want a hard fail on oversized diffs
                         rather than silent degradation via chunking
```

**Important:** The 80% threshold is always evaluated against the **resolved** model's `maxPromptTokens`, never against `model: "auto"`. Model resolution (auto-select or explicit validation) must complete before the chunking decision is made. This is the same ordering as the current pipeline — `resolveModel()` runs before `checkTokenBudget()`.

**Expected behavior:** With modern models (128k+ context), the vast majority of reviews (~70-80% for typical PRs) will fit in a single pass. Chunking primarily benefits large refactors, dependency updates, or reviews against smaller-context local models (e.g., Ollama with 8k-32k models). The `chunking: "auto"` default ensures zero overhead for the common case.

### Diff Splitting

The unit of chunking is a **file**. A single file is never split across chunks unless it alone exceeds the budget.

```
Step 1: Split raw diff into per-file segments
  Parse unified diff by "diff --git" boundaries.
  Result: Map<filePath, { raw: string, file: FileChange }>

  Hunk header parsing must handle all unified diff variants:
    @@ -10,5 +10,8 @@    — standard modified file
    @@ -0,0 +1,45 @@     — newly added file (no old content)
    @@ -1,45 +0,0 @@     — deleted file (no new content)
    @@ -1 +1 @@           — single-line change (count omitted = 1)

Step 2: Estimate tokens per file
  tokens ≈ segment.length / 4

Step 3: Bin-pack files into chunks (first-fit decreasing)
  Budget calculation:
    systemPromptTokens = systemPrompt.length / 4
    messageFraming     = 150 tokens  (role markers, chunk header, file list, code fence)
    perFileOverhead    = 10 tokens   (per file in the chunk: path listing)
    chunkBudget        = maxPromptTokens - systemPromptTokens - messageFraming

  "Fits" definition:
    A file fits in a chunk when:
      currentChunkTokens + fileTokens + (perFileOverhead * filesInChunk) <= chunkBudget

  Algorithm (first-fit decreasing):
    Sort files by token estimate, largest first (stable sort).
    Tie-breaking for equal token estimates: alphabetical by path (deterministic, reproducible output).
    For each file:
      if file fits in current chunk → add it
      if file doesn't fit and current chunk is non-empty → seal chunk, start new one
      if file alone exceeds chunkBudget → hunk-level split (Step 4)

Step 4: Hunk-level fallback (rare — massive single files only)
  Split the file's diff by @@ hunk headers.
  Bin-pack hunks into chunks the same way.
  If a single hunk exceeds budget → truncate with warning.
```

### Three-Phase Pipeline

**Phase 1: MAP — Review each chunk independently**

```
For each chunk (sequential):
  System prompt: same review prompt
  User message:
    "Review chunk {i} of {n}."
    "Files in this chunk: [list]"
    "```diff
    {chunk diff}
    ```"

  → Send to provider.chat()
  → Collect: findings text + usage
  → Emit progress: "Chunk {i}/{n} done"
```

Sequential execution because:
- Respects provider rate limits (especially Ollama on local hardware).
- Predictable progress reporting — each chunk completion is a natural progress event.
- Simpler error handling — fail fast on chunk 1 auth errors.

**Phase 2: REDUCE — Aggregate and reconcile**

```
System prompt:
  "You are a code review aggregator. Deduplicate findings,
   reconcile severity, flag cross-file issues, produce a
   unified review report."

User message:
  "The following are review findings from {n} review passes
   over different parts of a diff. Produce a single unified review."

  "## Chunk 1 (files: a.ts, b.ts)"
  {chunk 1 findings}

  "## Chunk 2 (files: c.ts, d.ts)"
  {chunk 2 findings}
  ...

  → Send to provider.chat()
  → Result: unified review
```

The reduce pass sees **findings only**, not raw diffs — so it fits in the token budget even for large reviews.

Uses the same model as the map passes — the resolved `ModelInfo` from the initial model resolution step is reused for all map passes and the reduce pass. No second auto-select call is made. Independently configurable reduce model is deferred to a future enhancement.

If only one chunk was produced (diff fit in a single chunk after all), the reduce pass is **skipped** — no aggregation needed.

**Reduce pass token budget calculation:**

```
reducePromptTokens = reduceSystemPrompt.length / 4  (≈ 50 tokens, it's short)
findingsTokens = sum(chunkFindings[i].length / 4)    for all chunks
framingOverhead = 100 + (numChunks * 30)              chunk headers, instructions
totalReduceInput = reducePromptTokens + findingsTokens + framingOverhead

reduceBudget = maxPromptTokens * 0.9   (leave 10% headroom for the model)
```

**Overflow handling** (when `totalReduceInput > reduceBudget`):

The reduce input can overflow in pathological cases — e.g., 50 chunks each producing 2000 tokens of findings = 100k tokens. Strategy uses **severity-aware truncation** to preserve high-priority findings:

1. Calculate available space: `available = reduceBudget - reducePromptTokens - framingOverhead`
2. For each chunk's findings, split into severity tiers by scanning for `### HIGH`, `### MEDIUM`, `### LOW` markers:
   - **Tier 1 (preserve):** HIGH findings — never truncated
   - **Tier 2 (compress):** MEDIUM findings — truncated last
   - **Tier 3 (expendable):** LOW findings — truncated first
3. Truncation rounds (stop as soon as total fits within `available`):
   - **Round 1:** Remove LOW findings from all chunks, replace with `[{n} LOW findings omitted]`
   - **Round 2:** Truncate MEDIUM findings proportionally across chunks (keep first paragraph of each, drop suggestion blocks)
   - **Round 3:** If still over budget, truncate MEDIUM findings to one-line summaries
   - **Round 4 (last resort):** Proportional truncation of remaining content per chunk
4. Emit warning: `"Reduce pass: truncated findings to fit token budget (preserved all HIGH, {n} MEDIUM compressed, {m} LOW omitted)"`

This ensures HIGH findings are never lost. In the pathological case where HIGH findings alone exceed the budget, fall back to proportional truncation across all content with a warning.

**Phase 3: FORMAT — Same as current**

```
Take unified review from reduce pass (or single chunk findings).
Apply existing formatter (markdown/text/json).
Add metadata: model, total tokens across all rounds, chunk count, files reviewed.
```

### File & Line References in Findings

The default review prompt already shows `**File:** \`path\` **Line:** <range>` as the expected output format, but compliance is inconsistent because the model must infer line numbers from raw `@@` hunk headers.

**Improvements (applied in both single-pass and chunked modes):**

1. **Enhanced user message** — `assembleUserMessage()` includes a structured file manifest before the diff:

```
## Files Changed
| File | Status | Lines Changed |
|------|--------|---------------|
| src/db/queries.ts | modified | 42-58, 103-110 |
| src/api/handler.ts | added | 1-89 |
```

The line ranges are extracted from `@@ +start,count @@` hunk headers during diff parsing. This gives the model an explicit lookup table rather than forcing it to parse raw hunks.

2. **Prompt update** — change the review rules to *recommend* (not require) file/line references: "Where possible, include the file path and line number(s) for each finding. Some findings (e.g., architectural concerns, missing code) may not have a specific location — that is fine."

3. **Chunked review context** — in chunked mode, each chunk's user message includes the file manifest for only that chunk's files.

### Token Accounting

```typescript
interface ChunkedReviewResult extends ReviewResult {
  chunks: {
    files: string[];
    usage: { totalTokens: number };
  }[];
  reduceUsage: { totalTokens: number };
  // usage (inherited) = sum of all chunk + reduce tokens
}
```

### Streaming with Chunked Review

For `stream: true` with chunking enabled:

- **Map phase**: always **buffered** (non-streaming) — each chunk is a complete `provider.chat()` call. Between chunks, emit progress markers to stderr: `"Reviewing chunk 2/5 (auth.ts, middleware.ts)..."`. Buffering the map phase is necessary because findings must be fully collected before the reduce pass.
- **Reduce phase**: **streamed** via `provider.chatStream()` — the final aggregated output streams to stdout as it arrives.
- **Mid-file hunk splits**: when a file is split across chunks at hunk boundaries, each chunk's progress marker includes the file path with a `(partial)` suffix: `"Reviewing chunk 3/5 (large-file.ts (partial), utils.ts)..."`

**Non-streaming chunked mode** (`stream: false`):

All phases (map + reduce) use `provider.chat()` (buffered). Progress markers still emit to stderr between chunks. The final formatted result is returned as a single `ReviewResult` — same shape as the current single-pass buffered review. The caller (CLI/MCP) sees no difference in the return type, only in the stderr progress output and potentially richer token accounting.

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| Zero files in diff | No chunks, skip review |
| 1 file, fits in budget | Single pass — no chunking overhead |
| 1 file, exceeds budget | Hunk-level split → map-reduce |
| All files fit in 1 chunk | 1 chunk → skip reduce pass |
| 10 files, need 3 chunks | 3 map passes + 1 reduce |
| Reduce input exceeds budget | Truncate oldest chunk findings with warning |
| Provider error on chunk N | Fail entire review: "Review failed on chunk {n}/{total} (files: [...]): {cause}". No partial results. |
| Empty chunk findings | Include in reduce with note "no issues found in chunk N" |
| Single hunk exceeds budget | Truncate hunk with warning, continue review |

### Example Chunked Review Output

For a diff spanning 8 files split into 3 chunks (markdown format):

```markdown
# Copilot Code Review

**Model:** gpt-4.1 | **Files:** 8 | **+342 -89** | **Chunks:** 3

## Findings

### HIGH

1. **SQL Injection in `db/queries.ts:45`** — User input interpolated directly into query string...

### MEDIUM

2. **Missing null check in `api/handler.ts:112`** — `req.body.userId` accessed without validation...
3. **Race condition in `cache/manager.ts:67`** — Concurrent cache invalidation can leave stale entries...

### LOW

4. **Unused import in `utils/format.ts:3`** — `lodash.merge` imported but never used...

---
*Tokens used: 12,450 (3 chunks + aggregation) | Model: gpt-4.1*
```

Stderr progress during the review:

```
Reviewing chunk 1/3 (db/queries.ts, db/migrations.ts, db/schema.ts)... done (3,200 tokens)
Reviewing chunk 2/3 (api/handler.ts, api/middleware.ts, api/router.ts)... done (2,800 tokens)
Reviewing chunk 3/3 (cache/manager.ts, utils/format.ts)... done (1,950 tokens)
Aggregating findings... done (4,500 tokens)
```

---

## 5. File Structure

### New files

```
src/lib/
├── providers/
│   ├── types.ts                    # ReviewProvider interface
│   ├── openai-chat-provider.ts     # Base class (shared OpenAI-compatible protocol)
│   ├── copilot-provider.ts         # Copilot (merges current client.ts + models.ts)
│   ├── ollama-provider.ts          # Ollama
│   └── index.ts                    # createProvider() factory
├── chunking.ts                     # Diff splitting, bin-packing, chunk types
```

### Modified files

```
src/lib/
├── review.ts       # Signature change (provider replaces client+models), chunk routing
├── types.ts        # New config fields, ChunkedReviewResult (~30 lines added)
├── config.ts       # Env var layer, new fields, new config paths + fallback (~60 lines added)
├── prompt.ts       # Chunk message + reduce prompt assembly (~40 lines added)
├── formatter.ts    # Chunk metadata in output header (~15 lines added)

src/
├── cli.ts          # createProvider(), new CLI flags (~20 lines changed)
├── mcp-server.ts   # createProvider() swap (~10 lines changed)
```

### Deleted files

```
src/lib/
├── client.ts       # Logic relocates to openai-chat-provider.ts + copilot-provider.ts
├── models.ts       # Logic relocates into provider implementations
```

### Unchanged files

```
src/lib/
├── streaming.ts    # Reused by OpenAIChatProvider base class
├── auth.ts         # Reused by CopilotProvider
├── diff.ts         # No changes needed
```

---

## 6. Error Handling

### New Error Scenarios

| Scenario | Error Class | Code | Message |
|----------|-------------|------|---------|
| Unknown provider name | `ConfigError` | `unknown_provider` | "Unknown provider '{name}'. Available: copilot, ollama" |
| Ollama unreachable | `ClientError` | `provider_unavailable` | "Cannot reach Ollama at {url}. Is it running?" |
| Ollama model not found | `ModelError` | `model_not_found` | "Model '{id}' not found on Ollama. Run `copilot-review models --provider ollama` to see available models." |
| No model specified, provider lacks auto-select | `ConfigError` | `model_required` | "Provider '{name}' requires an explicit model. Use --model or set in config." |
| Chunk N fails | `ReviewError` | `chunk_failed` | "Review failed on chunk {n}/{total} (files: [...]): {cause}" |
| Reduce pass fails | `ReviewError` | `reduce_failed` | "Aggregation pass failed: {cause}" |
| Single hunk exceeds budget | Warning | — | Truncate hunk, continue with warning |

No new error classes needed — all scenarios fit existing classes with new error codes.

**Actionable messages principle:** Every user-facing error message must include a concrete next step. "Cannot reach Ollama" is insufficient — "Cannot reach Ollama at http://localhost:11434. Is Ollama running? Start it with `ollama serve`." gives the user a path forward. This applies to all providers, not just Ollama.

### Retry Behavior Per Provider

- **CopilotProvider**: existing retry logic (exponential backoff, retry on 429/502/503/504).
- **OllamaProvider**: retry on connection refused (Ollama may be starting up) and 503. No rate limiting concern.
- **Base class**: retry logic in `OpenAIChatProvider` with `shouldRetry(error)` override point.

---

## 7. Impact Assessment

### Invasiveness

| File | Lines | Change Type | Impact |
|------|-------|-------------|--------|
| `client.ts` | 533 | **Delete** — logic relocates to provider classes | High (relocation, not rewrite) |
| `models.ts` | 322 | **Delete** — logic relocates into providers | Medium (relocation) |
| `review.ts` | 208 | **Modify** — signature change, chunk routing added | Medium |
| `types.ts` | 330 | **Modify** — ~30 lines added | Low |
| `config.ts` | 262 | **Modify** — ~60 lines added | Medium |
| `cli.ts` | ~220 | **Modify** — ~40 lines changed (new flags + status subcommand handler) | Low–Medium |
| `mcp-server.ts` | ~100 | **Modify** — ~10 lines changed | Low |
| `prompt.ts` | ~50 | **Modify** — ~40 lines added | Low |
| `formatter.ts` | ~80 | **Modify** — ~15 lines added | Low |
| `streaming.ts` | ~200 | **Unchanged** | None |
| `auth.ts` | ~250 | **Unchanged** | None |
| `diff.ts` | ~150 | **Unchanged** | None |

### New Code Estimates

| File | Est. Lines | Complexity |
|------|-----------|------------|
| `providers/types.ts` | ~30 | Interface only |
| `providers/openai-chat-provider.ts` | ~250 | Ported from client.ts |
| `providers/copilot-provider.ts` | ~200 | Copilot-specific logic from client.ts + models.ts |
| `providers/ollama-provider.ts` | ~80 | Thin — inherits base, adds /api/tags |
| `providers/index.ts` | ~30 | Factory |
| `chunking.ts` | ~150 | New logic — bin-packing, hunk splitting |

**Net**: ~350 new lines, ~850 relocated. Genuinely new logic is ~150 lines in `chunking.ts`.

---

## 8. Testing Strategy

### Unit Tests

| Module | Focus |
|--------|-------|
| `openai-chat-provider.ts` | Mock fetch — request body construction, response parsing, retry logic, SSE streaming. Test via concrete test subclass. |
| `copilot-provider.ts` | Session token exchange, Responses API routing, model discovery/dedup, auto-select, headers |
| `ollama-provider.ts` | `/api/tags` → `ModelInfo[]` parsing, no-auth headers, base URL config |
| `providers/index.ts` | Factory returns correct provider, throws on unknown |
| `chunking.ts` | **Heavy testing** — bin-packing correctness, file boundary preservation, hunk fallback, edge cases |
| `config.ts` | Env var precedence, new paths with fallback, new fields merge |
| `review.ts` | Auto-chunk threshold, single-pass vs map-reduce routing, reduce receives findings not diffs, token sums |
| `prompt.ts` | Chunk message assembly, reduce prompt assembly |
| `cli.ts` (status) | Config resolution display, health check pass/fail, exit codes, JSON output |

### Chunking Edge Cases (must all be covered)

```
1. Zero files              → no chunks, skip review
2. One small file          → 1 chunk, skip reduce
3. 10 files, all fit       → 1 chunk, skip reduce
4. 10 files, need 3 chunks → 3 map passes + 1 reduce
5. One file exceeds budget → hunk-level split
6. One hunk exceeds budget → truncate with warning
7. Files sorted largest-first → verify bin-packing efficiency
```

### Test Mocking Patterns

The `ReviewProvider` interface simplifies test mocking compared to the current setup (which requires mocking both `CopilotClient` and `ModelManager`):

```typescript
// Test helper: create a mock provider for unit tests
class MockProvider implements ReviewProvider {
  readonly name = "mock";
  chatResponse: ChatResponse = { content: "No issues.", model: "mock", usage: { totalTokens: 10 } };
  models: ModelInfo[] = [{ id: "mock-model", name: "Mock", ... }];

  async chat(req: ChatRequest): Promise<ChatResponse> { return this.chatResponse; }
  async *chatStream(req: ChatRequest): AsyncIterable<StreamChunk> { yield { type: "done", usage: { totalTokens: 10 } }; }
  async listModels(): Promise<ModelInfo[]> { return this.models; }
  async validateModel(id: string): Promise<ModelInfo> { return this.models[0]; }
  async healthCheck() { return { ok: true, latencyMs: 1 }; }
}
```

For `OpenAIChatProvider` base class testing, use a concrete test subclass with `msw` for HTTP mocking (same pattern as current `client.test.ts`). This tests the shared protocol logic without coupling to Copilot or Ollama specifics.

### Integration Tests (Ollama)

- Skip if Ollama not available (check `OLLAMA_AVAILABLE` env var or health endpoint).
- Smoke test: list models, chat with small prompt, verify response shape.
- Chunked review against a known diff with a small-context model to force chunking.

---

## 9. Future Enhancements (Out of Scope)

- **Independently configurable reduce model** — allow a different (smaller/cheaper) model for the aggregation pass.
- **Runtime plugin loading** — file-based or npm-based provider plugins.
- **Parallel chunk execution** — configurable concurrency for providers that support it.
- **Project rename** — `copilot-review` → provider-neutral name.
- **Anthropic provider** — implement `ReviewProvider` directly (non-OpenAI protocol).
- **Config migration tooling** — `copilot-review migrate-config` to move `~/.copilot-review/` → `~/.code-reviewer/` with deprecation warnings when old paths are detected.
- **File/directory scoped review** — `copilot-review local --path src/lib/auth.ts` or `--path src/lib/` to review only specific files or directories, filtering the diff to matching paths before sending to the provider.
