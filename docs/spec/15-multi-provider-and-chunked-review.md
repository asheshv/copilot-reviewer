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
  └── (future: AnthropicProvider, etc. — implement interface directly)
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

### Provider Factory

```typescript
// src/lib/providers/index.ts

export function createProvider(config: ResolvedConfig): ReviewProvider {
  switch (config.provider) {
    case "copilot":
      return new CopilotProvider(createDefaultAuthProvider());
    case "ollama":
      const url = config.providerOptions.ollama?.baseUrl
        ?? "http://localhost:11434";
      return new OllamaProvider(url);
    default:
      throw new ConfigError(
        "unknown_provider",
        `Unknown provider '${config.provider}'. Available: copilot, ollama`,
        "config",
        false
      );
  }
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
  estimate tokens = (systemPrompt.length + diff.raw.length) / 4
  if estimate < 80% of model maxPromptTokens → single pass (current behavior)
  if estimate >= 80% → chunk and map-reduce

chunking = "always":  → always chunk, even small diffs
chunking = "never":   → current behavior, throw ReviewError if diff too large
```

### Diff Splitting

The unit of chunking is a **file**. A single file is never split across chunks unless it alone exceeds the budget.

```
Step 1: Split raw diff into per-file segments
  Parse unified diff by "diff --git" boundaries.
  Result: Map<filePath, { raw: string, file: FileChange }>

Step 2: Estimate tokens per file
  tokens ≈ segment.length / 4

Step 3: Bin-pack files into chunks (first-fit decreasing)
  Available budget per chunk = maxPromptTokens - systemPromptTokens - overhead
  (overhead ≈ 200 tokens for message framing and chunk context header)

  Sort files by token estimate, largest first.
  For each file:
    if file fits in current chunk → add it
    if file doesn't fit and current chunk is non-empty → seal chunk, start new one
    if file alone exceeds budget → hunk-level split (Step 4)

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

Uses the same model as the map passes. Independently configurable reduce model is deferred to a future enhancement.

If only one chunk was produced (diff fit in a single chunk after all), the reduce pass is **skipped** — no aggregation needed.

**Phase 3: FORMAT — Same as current**

```
Take unified review from reduce pass (or single chunk findings).
Apply existing formatter (markdown/text/json).
Add metadata: model, total tokens across all rounds, chunk count, files reviewed.
```

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

- **Map phase**: emit progress markers between chunks (`"--- Reviewing chunk 2/5 (auth.ts, middleware.ts) ---"`)
- **Reduce phase**: stream the final aggregated output as it comes.

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
| Ollama model not found | `ModelError` | `model_not_found` | Same as current — lists available models |
| No model specified, provider lacks auto-select | `ConfigError` | `model_required` | "Provider '{name}' requires an explicit model. Use --model or set in config." |
| Chunk N fails | `ReviewError` | `chunk_failed` | "Review failed on chunk {n}/{total} (files: [...]): {cause}" |
| Reduce pass fails | `ReviewError` | `reduce_failed` | "Aggregation pass failed: {cause}" |
| Single hunk exceeds budget | Warning | — | Truncate hunk, continue with warning |

No new error classes needed — all scenarios fit existing classes with new error codes.

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
| `cli.ts` | ~220 | **Modify** — ~20 lines changed | Low |
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
