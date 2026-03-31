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
- Renaming the project from `llm-review` — cosmetic, deferred.

---

## 1. Provider Interface

The core abstraction. Every provider implements this interface.

```typescript
// src/lib/providers/types.ts

export interface ReviewProvider {
  readonly name: string;

  /**
   * Validate provider configuration and connectivity. Called once after construction,
   * before any other method. Allows fail-fast on misconfiguration (bad URL, auth failure)
   * before the review pipeline starts. Throws on failure — callers should not proceed
   * if initialize() rejects.
   *   - CopilotProvider: validates auth token, exchanges session token
   *   - OllamaProvider: checks base URL reachability (GET /api/tags, 5s timeout)
   * This is separate from healthCheck() — initialize() is required for normal operation,
   * healthCheck() is diagnostic-only (status command).
   *
   * Contract:
   *   - Idempotent: calling initialize() multiple times is safe (second+ calls are no-ops)
   *   - If initialize() throws, the provider is safe to dispose() immediately
   *   - Partial success (e.g., auth OK but model list fails) is treated as failure — throws
   */
  initialize(): Promise<void>;

  /** Non-streaming chat completion. Throws ClientError on API failure. */
  chat(request: ChatRequest): Promise<ChatResponse>;

  /**
   * Streaming chat completion. Yields StreamChunk objects.
   * Error contract:
   *   - Connection/auth errors: throws before yielding any chunks
   *   - Mid-stream errors: yields { type: "error", text: "..." } chunk, then returns
   *     (does NOT throw — caller must check for error chunks)
   *     Provider MUST NOT yield any further chunks after an error chunk.
   *     The AsyncIterable completes (returns) immediately after the error chunk.
   *   - Normal completion: final chunk is { type: "done", usage, model }
   * Callers MAY break iteration early upon receiving an error chunk.
   * If callers consume the full iterable, cleanup is guaranteed.
   */
  chatStream(request: ChatRequest): AsyncIterable<StreamChunk>;

  /** List available models on this provider. Throws ClientError on API failure. */
  listModels(): Promise<ModelInfo[]>;

  /** Validate a model ID exists. Throws ModelError if not found. */
  validateModel(id: string): Promise<ModelInfo>;

  /**
   * Auto-select best model (optional — not all providers support this).
   * When absent, callers must check and require explicit model selection:
   *   if (!provider.autoSelect) throw ConfigError("model_required", ...)
   */
  autoSelect?(): Promise<string>;

  /**
   * Release any resources held by this provider (cached tokens, open connections).
   * Called when the provider is no longer needed — CLI exit, MCP server shutdown.
   * Must not throw — swallow errors and log to stderr if DEBUG is set.
   * Must complete synchronously (no async cleanup).
   * SECURITY: CopilotProvider.dispose() MUST zero out the cached session token
   * (set to empty string, not just null the reference) to prevent credential leakage
   * if the process stays alive (e.g., MCP server mode).
   *   - CopilotProvider: zeros cached session token, clears refresh promise
   *   - OllamaProvider: no-op (stateless, no credentials)
   * Not called between individual review calls — providers are long-lived within a session.
   * CLI: called in process exit handler. MCP server: called on transport close.
   */
  dispose(): void;

  /**
   * Health check — verify provider is reachable. Returns latency in ms.
   * Called only by the `status` command, never during normal review flow
   * (review errors surface through chat/chatStream naturally).
   * Implementations should use the lightest possible request:
   *   - Copilot: GET /models (already needed for validation)
   *   - Ollama: GET /api/tags (lightweight, returns quickly)
   * Timeout: 5 seconds (hardcoded, not configurable). If the provider
   * doesn't respond within 5s, return { ok: false, latencyMs: null, error: "timeout" }.
   * Must not throw — return error in the result object.
   * May be called before initialize() — for the status command, we want to check
   * reachability without full initialization. If credentials are needed for the health
   * endpoint, healthCheck() returns { ok: false, error: "not_initialized" }.
   */
  healthCheck(): Promise<{ ok: boolean; latencyMs: number | null; error?: string }>;
}
```

Key decisions:

- `chat` and `chatStream` use the existing `ChatRequest` / `ChatResponse` / `StreamChunk` types unchanged — they are already provider-agnostic. The existing `StreamChunk.type` union already includes `"error"` (see `types.ts:165`: `type: "content" | "reasoning" | "error" | "done" | "warning"`).
- **Error types:** `chat`/`chatStream`/`listModels` throw `ClientError`. `validateModel` throws `ModelError`. `initialize` throws `AuthError` or `ClientError`. This matches the existing error hierarchy — callers already handle these types.
- `listModels` and `validateModel` move into the provider. Currently split across `CopilotClient` + `ModelManager`, they merge into a single provider object.
- `autoSelect` is optional — Copilot has this endpoint, most others do not. The review pipeline checks `if (!provider.autoSelect)` before calling and throws `ConfigError("model_required")` with an actionable message.
- The `useResponsesApi` boolean currently threaded through client code becomes an internal Copilot implementation detail, hidden behind the interface.

**ModelInfo interface** (existing, unchanged — shown for reference):

```typescript
interface ModelInfo {
  id: string;                // e.g., "gpt-4.1"
  name: string;              // human-readable name
  endpoints: string[];       // ["/chat/completions", "/responses"]
  streaming: boolean;        // supports streaming
  toolCalls: boolean;        // supports tool calls
  maxPromptTokens: number;   // context window for input
  maxOutputTokens: number;   // max generation length
  tokenizer: string;         // e.g., "o200k_base"
}
```

For Ollama, `endpoints` is always `["/v1/chat/completions"]`, `tokenizer` is `"unknown"`, and `maxPromptTokens` comes from `/api/show` discovery (see OllamaProvider).

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

  private _initialized = false;

  constructor(protected baseUrl: string) {}

  /** Default initialize() — subclasses override for provider-specific validation */
  async initialize(): Promise<void> {
    if (this._initialized) return;  // idempotent
    // Subclasses override to add auth validation, connectivity checks, etc.
    this._initialized = true;
  }

  /** Default dispose() — subclasses override for cleanup */
  dispose(): void { /* no-op by default */ }

  /**
   * Subclasses provide request headers. Return value MUST include:
   *   - "Authorization": "Bearer ..." (if provider requires auth)
   * For no-auth providers like Ollama, return empty object {}.
   * The base class adds "Content-Type: application/json" automatically —
   * subclass headers CANNOT override it (base-class headers win on collision).
   */
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

Retry logic lives in the base class:

```typescript
// In OpenAIChatProvider:

/** Max retries, backoff, jitter — same as current client.ts implementation */
protected async retry<T>(fn: () => Promise<T>): Promise<T> { /* ... */ }

/**
 * Determine if an error is retryable. Subclasses override for provider-specific behavior.
 * Default: retry on rate_limited (429), server_error (502/503/504), timeout.
 */
protected shouldRetry(error: ClientError): boolean {
  return error.code === "rate_limited" ||
         error.code === "server_error" ||
         error.code === "timeout";
}
```

- `CopilotProvider`: inherits default (same as current behavior) + retries on 403 with rate-limit headers.
- `OllamaProvider`: overrides to also retry on `ECONNREFUSED` (Ollama may be starting up). Transforms Node.js `ECONNREFUSED` into `ClientError("provider_unavailable")` before calling `shouldRetry()`.

**Mid-stream errors:** `shouldRetry()` applies only to `chat()` (buffered). For `chatStream()`, retries are not attempted — the stream contract yields an error chunk instead (see interface docs above). The caller decides whether to retry the full request.

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
  //
  // Responses API fallback criteria:
  //   Primary: use /responses if model.endpoints includes "/responses"
  //   Fallback: if /responses returns 404 or 400 (not 401/403/429),
  //     retry once with /chat/completions (same model, different body format)
  //   No fallback on: auth errors (401/403), rate limits (429), server errors (5xx)
  //   Fallback is tracked internally (provider sets a flag to skip /responses for this model
  //   for the remainder of the session). Callers are unaware — no stderr dependency.

  // listModels() — current ModelManager logic (filter, dedup, policy enable)
  // autoSelect() — current /models/session logic
  // getHeaders() — Copilot-specific headers + session token exchange
  //
  // Concurrency safety: the current auth.ts already uses a refreshPromise mutex
  // to prevent concurrent token refresh races. CopilotProvider inherits this —
  // multiple concurrent getHeaders() calls wait on the same refresh promise.
  // The /responses fallback flag (per-model Map<string, boolean>) is only written
  // during sequential chat() calls within a single review pipeline, so no
  // concurrent write risk in practice.
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
  // listModels() — two-step discovery:
  //   1. GET /api/tags → list of model names
  //      Error: if GET fails (connection error, 500, timeout) → throw ClientError
  //      Error: if response is not JSON or missing .models array → throw ClientError
  //      Edge: if Ollama is old version without /api/tags → throw ClientError("unsupported_version")
  //   2. For each model, POST /api/show { name } → extract context length
  //      from modelfile parameters (num_ctx) or model metadata.
  //      Fallback: if /api/show fails for a single model → log warning, use default 4096 tokens
  //      Fallback: if context length field missing in response → use default 4096 tokens
  //      (conservative — avoids overflowing small models).
  //      Error: if ALL /api/show calls fail → still return models with 4096 defaults (don't fail)
  //   Transform to ModelInfo[] with maxPromptTokens from discovered context length.
  //   Cache results for 5 minutes (same TTL as Copilot).
  //   Concurrent callers share the same in-flight promise (coalesce pattern,
  //   same as auth.ts refreshPromise) to avoid thundering herd on /api/show.
  //   Edge: if /api/tags returns empty array → return [] (no models installed, not an error)
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
let parsed: URL;
try {
  parsed = new URL(baseUrl);
} catch {
  throw new ConfigError("invalid_url",
    `Invalid Ollama base URL '${baseUrl}'. Expected format: http://host:port`,
    baseUrl, false);
}
if (parsed.pathname !== "/" && parsed.pathname !== "") {
  throw new ConfigError("invalid_url",
    `Ollama base URL must not include a path (got '${parsed.pathname}'). Use the root URL, e.g., http://localhost:11434`,
    baseUrl, false);
}
if (parsed.search || parsed.hash) {
  throw new ConfigError("invalid_url",
    `Ollama base URL must not include query parameters or fragments. Remove '${parsed.search}${parsed.hash}'`,
    baseUrl, false);
}
// parsed.host includes port when non-default (e.g., "localhost:11434")
// parsed.host omits port when it's the protocol default (e.g., "localhost" for http on 80)
// This is correct — we want the full host:port.
this.baseUrl = `${parsed.protocol}//${parsed.host}`;
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

export async function createProvider(config: ResolvedConfig): Promise<ReviewProvider> {
  const factory = PROVIDERS[config.provider];
  if (!factory) {
    const available = Object.keys(PROVIDERS).join(", ");
    throw new ConfigError(
      "unknown_provider",
      `Unknown provider '${config.provider}'. Available: ${available}. Check your config file or --provider flag.`,
      config.provider,   // include the source that resolved this value
      false
    );
  }
  try {
    const provider = factory(config);
    await provider.initialize();
    return provider;
  } catch (error) {
    // Wrap provider construction errors with context about which provider failed
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(
      "provider_init_failed",
      `Failed to initialize provider '${config.provider}': ${error instanceof Error ? error.message : String(error)}`,
      config.provider,
      false,
      error instanceof Error ? error : undefined
    );
  }
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
  providerOptions: {
    ollama?: { baseUrl: string };       // resolved with default applied
    // Future providers add their own key here.
    // Each key is the provider name; value is provider-specific config.
    //
    // Unknown key handling: during config loading, warn on stderr if a
    // providerOptions key doesn't match any registered provider name:
    //   "Warning: unknown providerOptions key 'olama' — did you mean 'ollama'?"
    // Uses Levenshtein distance <= 2 against availableProviders() for suggestions.
    // The key is still preserved (forward-compatible for newer versions).
    [key: string]: Record<string, unknown> | undefined;
  };
  chunking: "auto" | "always" | "never";
}
```

### Config Directory Rename

New paths:

- **Global**: `~/.llm-reviewer/config.json`
- **Project**: `<git-root>/.llm-reviewer/config.json`

Backward compatibility: if the new path does not exist, fall back to the old path (`~/.llm-review/`). New path takes precedence if both exist. Fallback is **file-level** — the entire config file is loaded from one path or the other, never merged field-by-field across both paths.

**Migration risk assessment:** We considered the risk of silent config loss when both `~/.llm-reviewer/` and `~/.llm-review/` exist. The precedence rule (new path wins) is deterministic, but a user who manually edits the old path after the new one was auto-created would see their changes ignored without any feedback.

Mitigations:
- The `status` command shows exactly which config file is loaded and whether the fallback path exists, making debugging straightforward.
- The tool **never auto-creates** config directories — users create them explicitly. This eliminates the "auto-created new path shadows old path" scenario.
- If both paths exist, the `status` command shows: `Config (global): ~/.llm-reviewer/config.json (found, note: ~/.llm-review/config.json also exists — ignored)`.
- Additionally, during normal `review` invocation, if both paths exist, emit a **one-time warning to stderr**: `"Warning: both ~/.llm-reviewer/ and ~/.llm-review/ exist. Using ~/.llm-reviewer/. Run 'llm-review status' for details."` This is NOT silent — it surfaces the shadowing during actual use, not just in the diagnostic command.

A future migration tool or deprecation warning is out of scope but documented in Section 9.

### Config Merge Order (updated)

```
Layer  Source                         Fields affected
─────  ─────────────────────────────  ───────────────────────────────────────────────
1      Built-in defaults              all fields (provider: "copilot", model: "auto",
                                      format: "markdown", stream: true, chunking: "auto",
                                      prompt: built-in, defaultBase: "main", ignorePaths: [])
2      LLM_REVIEWER_PROVIDER env      provider only
3      LLM_REVIEWER_OLLAMA_URL env    providerOptions.ollama.baseUrl only
                                      (validated as parseable URL at config load time;
                                      throws ConfigError immediately if malformed — don't
                                      defer to provider construction)
3b     LLM_REVIEWER_CHUNKING env     chunking only (kill switch: "never" disables chunking)
4      Global config file             all ConfigFile fields (provider, model, format,
       ~/.llm-reviewer/config.json   stream, prompt, defaultBase, ignorePaths, chunking,
       (fallback: ~/.llm-review/) providerOptions, mode)
                                      URL fields (providerOptions.ollama.baseUrl) validated
                                      at config load time, same as env vars
5      Project config file            same as layer 4
       <git-root>/.llm-reviewer/
       (fallback: .llm-review/)
6      CLI overrides                  --provider, --model, --format, --stream/--no-stream,
                                      --prompt, --chunking, --ollama-url, --config
```

Environment variables slot between defaults and config files — config files can override them, CLI always wins. Each layer only overrides fields it explicitly sets; unset fields pass through from the previous layer.

**Validation timing:** All env vars and config file values are validated eagerly during `loadConfig()`. Invalid values (malformed URLs, unknown chunking modes) throw `ConfigError` immediately — before provider construction or review pipeline starts. `LLM_REVIEWER_PROVIDER` is **not** validated against `availableProviders()` at config time (it's just a string); validation happens in `createProvider()` where the registry is available.

**`providerOptions` merge semantics:** shallow merge per provider key. If project config sets `providerOptions.ollama`, it **replaces** the entire `ollama` object from the global config (not deep-merged). This is consistent with how the existing config merge works for simple fields and avoids surprising partial-override behavior. Example:

```
Global:  { providerOptions: { ollama: { baseUrl: "http://remote:11434" } } }
Project: { providerOptions: { ollama: { baseUrl: "http://localhost:11434" } } }
Result:  { providerOptions: { ollama: { baseUrl: "http://localhost:11434" } } }
```

### CLI Additions

```
--provider <name>       Review provider: copilot, ollama
--chunking <mode>       auto | always | never (default: auto)
--ollama-url <url>      Ollama base URL (shorthand for providerOptions.ollama.baseUrl)
```

The existing `llm-review models` subcommand becomes provider-aware: `llm-review models --provider ollama` lists Ollama models. Defaults to the configured provider.

### Status Command

New subcommand: `llm-review status`

Displays resolved configuration and provider health in a single view. Useful for debugging setup issues and confirming what the tool will use before running a review.

```
$ llm-review status

  Provider:       copilot
  Model:          auto → gpt-4.1 (auto-selected)
  Chunking:       auto
  Stream:         true
  Format:         markdown
  Config (global): ~/.llm-reviewer/config.json (found)
  Config (project): /repo/.llm-reviewer/config.json (not found, fallback: .llm-review/ not found)
  Auth:           GitHub token (gh CLI) ✓
  API reachable:  ✓ (245ms)
```

```
$ llm-review status --provider ollama

  Provider:       ollama
  Model:          (not set — required, use --model)
  Base URL:       http://localhost:11434
  Chunking:       auto
  Stream:         true
  Format:         markdown
  Config (global): ~/.llm-reviewer/config.json (found)
  Config (project): /repo/.llm-reviewer/config.json (not found)
  Auth:           none (not required)
  API reachable:  ✓ (12ms)
  Models:         deepseek-coder-v2, codellama:13b, qwen2.5-coder:7b
```

```
$ llm-review status --provider ollama

  Provider:       ollama
  ...
  API reachable:  ✗ — connection refused at http://localhost:11434
```

Behavior:
- Resolves the full config merge (defaults → env → global → project → CLI) and shows the result.
- Shows which config files were found and which fell back or were missing.
- For `model: auto`, resolves the auto-selection and shows both `auto → <resolved>`.
- Pings the provider's API to confirm reachability (lightweight health check, not a full chat call, 5s timeout).
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
  models: string[] | null;        // string[] when discovery succeeded; null when API unreachable
  modelsError: string | null;     // null when models succeeded; error message when discovery failed
                                  // Distinguishes: models=null + modelsError=null (not attempted, e.g. API unreachable)
                                  //                models=null + modelsError="timeout" (attempted, failed)
                                  //                models=[] + modelsError=null (succeeded, no models installed)
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
const provider = await createProvider(config);  // constructs + initialize()
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
                         Also serves as the **kill switch** — if chunking causes issues in
                         production, set chunking: "never" globally or per-project to disable
                         it entirely with zero code changes. The LLM_REVIEWER_CHUNKING env var
                         provides the same kill switch without config file changes:
                           LLM_REVIEWER_CHUNKING=never llm-review local
```

**Important:** The 80% threshold is always evaluated against the **resolved** model's `maxPromptTokens`, never against `model: "auto"`. Model resolution (auto-select or explicit validation) must complete before the chunking decision is made. This is the same ordering as the current pipeline — `resolveModel()` runs before `checkTokenBudget()`.

**Model resolution failure:** If model resolution fails (auto-select API error, model not found), the review fails immediately with `ModelError` — same as current behavior. Chunking is never attempted without a resolved model. There is no fallback to a default `maxPromptTokens`.

**Model resolution with providers that lack auto-select (e.g., Ollama):**
- `model: "auto"` + Ollama → `resolveModel()` checks `provider.autoSelect` → absent → throws `ConfigError("model_required", "Provider 'ollama' requires an explicit model. Use --model or set model in config. Run 'llm-review models --provider ollama' to see available models.")`
- This check happens early in the review pipeline, before diff collection or chunking.
- The `status` command also surfaces this: `Model: (not set — required, use --model)`
- CLI example: `llm-review --provider ollama` without `--model` → same error, exit code 5 (CONFIG_ERROR).

**Expected behavior:** With modern models (128k+ context), the vast majority of reviews (~70-80% for typical PRs) will fit in a single pass. Chunking primarily benefits large refactors, dependency updates, or reviews against smaller-context local models (e.g., Ollama with 8k-32k models). The `chunking: "auto"` default ensures zero overhead for the common case.

### Diff Splitting

The unit of chunking is a **file**. A single file is never split across chunks unless it alone exceeds the budget.

```
Step 1: Split raw diff into per-file segments
  Parse unified diff by "diff --git" boundaries.
  Result: Map<filePath, { raw: string, file: FileChange }>

  Error handling:
    - If raw diff contains no "diff --git" boundaries → treat entire diff as single file
      segment with path "unknown" (graceful degradation, not an error — some diff formats
      may lack git headers)
    - If a hunk header is malformed (doesn't match @@ regex) → skip that hunk, include
      surrounding content in the file segment, emit warning
    - Binary files (detected by "Binary files ... differ") → exclude from chunking,
      emit warning: "Binary file {path} excluded from review"

  Hunk header parsing must handle all unified diff variants:
    @@ -10,5 +10,8 @@    — standard modified file
    @@ -0,0 +1,45 @@     — newly added file (no old content)
    @@ -1,45 +0,0 @@     — deleted file (no new content)
    @@ -1 +1 @@           — single-line change (count omitted = 1)

Step 2: Estimate tokens per file
  tokens ≈ segment.length / 4

  Note: the char/4 heuristic underestimates for code-heavy diffs (~3.2 chars/token
  for code vs ~4.5 for English). The strict < in the "fits" check and the 80%
  threshold (not 100%) provide cumulative headroom. If a chunk overflows at the
  API level (model returns a context-length error), the review pipeline catches
  the ClientError and retries that specific chunk once with a reduced budget
  (chunkBudget * 0.8), re-running bin-packing for that chunk's files only.
  "Once" = exactly one retry per chunk — if 0.8x also overflows, the chunk fails
  with ReviewError. This budget-reduction retry is separate from the provider's
  built-in retry logic (which handles transient errors like 429/503). This
  self-corrects for estimation inaccuracy without requiring a precise tokenizer.

Step 3: Bin-pack files into chunks (first-fit decreasing)
  Budget calculation:
    systemPromptTokens = systemPrompt.length / 4
    messageFraming     = 150 tokens  (role markers, chunk header, file list, code fence)
    perFileOverhead    = 10 tokens   (per file in the chunk: path listing)
    chunkBudget        = maxPromptTokens - systemPromptTokens - messageFraming

  Guard: if maxPromptTokens <= 0 or chunkBudget <= 0, throw ReviewError("invalid_model_limits",
    "Model '{id}' reports maxPromptTokens={n} which is too small for review. Use a different model.")
  This prevents unbounded or negative-budget chunks.

  "Fits" definition (uses strict less-than to leave headroom for token estimation error):
    A file fits in a chunk when:
      currentChunkTokens + fileTokens + (perFileOverhead * (filesInChunk + 1)) < chunkBudget
    Note: filesInChunk + 1 because we're testing whether adding this file would fit.
    The < (not <=) gives a small safety margin for the char/4 token estimation inaccuracy.

  Algorithm: First-Fit Decreasing (FFD).
    Why FFD over Best-Fit Decreasing (BFD): FFD is simpler to implement, produces
    deterministic output, and for our use case (typically 5-50 files) the packing
    efficiency difference is negligible. BFD's tighter packing would add complexity
    for minimal gain — we're optimizing for review quality, not minimal chunk count.

    Estimation variance: if char/4 is off by ~20% for some files, FFD may produce
    suboptimal packing (one more chunk than necessary). This is acceptable — an extra
    chunk costs one more API call, not a correctness issue. The self-correcting retry
    (see Step 2 note) handles the case where a chunk actually overflows.

    Sort files by token estimate, largest first (stable sort).
    Tie-breaking for equal token estimates: alphabetical by path (deterministic, reproducible output).
    For each file:
      if file fits in current chunk → add it
      if file doesn't fit and current chunk is non-empty → seal chunk, start new one
      if file alone exceeds chunkBudget → hunk-level split (Step 4)

Step 4: Hunk-level fallback (rare — massive single files only)
  Split the file's diff by @@ hunk headers.
  Edge: if file has zero parseable hunks (only file header, no content changes) →
    treat entire file segment as one "hunk" for bin-packing purposes.
  Edge: if @@ headers are malformed → treat surrounding content as a single hunk.
  Bin-pack hunks into chunks the same way.
  If a single hunk exceeds budget → truncate:
    - Truncate to approximately `chunkBudget * 4` characters, but snap to the
      nearest newline boundary (scan backward for \n). This ensures truncation
      never breaks a diff line mid-syntax, which would confuse the model.
      Edge: if no newline found within the last 1000 characters (e.g., minified
      file), truncate at the character limit anyway — a broken line is better
      than exceeding the token budget.
    - Append: `\n... [truncated — {originalTokens} tokens reduced to {budgetTokens}. Full hunk too large for model context.]\n`
    - Preserve the @@ header line (so the model knows the file/line context)
    - Emit warning to stderr: `"Warning: hunk in {filePath} at line {startLine} truncated ({originalTokens} tokens exceeds {budgetTokens} budget). Consider reviewing this file separately with a larger-context model, or use ignorePaths to exclude it."`
    - The truncated hunk is placed in its own chunk (no other files added)
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
  → Collect: ChatResponse.content (raw model output — markdown text following the
    review prompt format: severity headers, file/line references, suggestions)
    + ChatResponse.usage
  → Emit progress: "Chunk {i}/{n} done"

  The map phase does NOT parse or validate the findings format — it passes the raw
  model output as-is to the reduce phase. Severity parsing only happens during
  reduce overflow truncation (Section 4, Overflow handling). If the model produces
  unexpected format, the reduce phase still receives it and does best-effort aggregation.
```

Sequential execution because:
- Respects provider rate limits (especially Ollama on local hardware).
- Predictable progress reporting — each chunk completion is a natural progress event.
- Simpler error handling — fail fast on chunk 1 auth errors.

The resolved `ModelInfo` is **not re-validated** between chunks. The model is resolved once before the pipeline starts. If a model becomes unavailable mid-review (provider restart, model unloaded), the chunk's `provider.chat()` call fails with `ClientError` and the review fails — the implicit API-level failure is the detection mechanism, not explicit re-validation.

**Auth/credential failure mid-pipeline:** If chunk 1 succeeds but chunk 2 gets `AuthError` (token expired), `AuthError` is non-retryable (see `shouldRetry()` — auth errors are never retried). The review fails immediately with "Review failed on chunk 2/N: {auth error}". For Copilot, the session token refresh logic in `getHeaders()` should prevent this (refreshes proactively when close to expiry), but if it happens, it's a hard failure.

**Phase 2: REDUCE — Aggregate and reconcile**

```
System prompt:
  "You are a code review aggregator. Deduplicate findings,
   reconcile severity, produce a unified review report.
   Flag any cross-file issues you can infer from the findings
   (e.g., API contract mismatches, inconsistent error handling).
   Only flag cross-file issues where evidence exists in the findings —
   do not speculate about files or code not shown.
   The full file list is provided at the end for context."

User message:
  "The following are review findings from {n} review passes
   over different parts of a diff. Produce a single unified review."

  "## Chunk 1 (files: a.ts, b.ts)"
  {chunk 1 findings}

  "## Chunk 2 (files: c.ts, d.ts)"
  {chunk 2 findings}
  ...

  "## All files in this review (for cross-file analysis)"
  [full file list with status — same manifest format as the user message]

  → Send to provider.chat()
  → Result: unified review
```

The reduce pass sees **findings only**, not raw diffs — so it fits in the token budget even for large reviews.

**Deduplication strategy:** The reduce pass relies on the LLM to deduplicate findings. This is intentional — algorithmic dedup (string matching, fuzzy matching) would miss semantic duplicates (same issue described differently across chunks) and would add complexity for marginal benefit. The reduce prompt explicitly instructs deduplication, and empirical testing with GPT-4.1 and Claude shows reliable dedup for the typical case (2-5 chunks). For pathological cases (50+ chunks), the severity-aware truncation already reduces the input volume. No algorithmic pre-dedup in v1; add if LLM dedup proves unreliable in practice.

**Aggregation quality validation:** The reduce pass output is not programmatically validated for dedup correctness — we trust the model. However, the test suite includes fixture-based tests with known duplicate findings across chunks, verifying that the reduce prompt produces reasonable output with the models we support. These are snapshot tests, not exact-match — they verify structure (findings count decreased, severity headers present) not content.

Uses the same model as the map passes — the resolved `ModelInfo` from the initial model resolution step is reused for all map passes and the reduce pass. No second auto-select call is made. This is intentional: model consistency across all phases ensures the reduce pass interprets findings in the same "voice" as the model that generated them. For Copilot's auto-select, the session token exchange caches for the session duration anyway, so a re-select would return the same model. Independently configurable reduce model is deferred to a future enhancement.

If only one chunk was produced (diff fit in a single chunk after all), the reduce pass is **skipped** — no aggregation needed. This applies even when `chunking: "always"` — if the diff only produces one chunk, the reduce pass adds no value. The `chunking: "always"` flag forces the chunking *pipeline* to run (bin-packing, chunk message format), but does not force a reduce pass when there's nothing to aggregate.

**Observable difference** between `chunking: "always"` producing 1 chunk vs. no chunking:
- The user message format differs: chunked mode prepends "Review chunk 1 of 1. Files in this chunk: [...]" before the diff. Non-chunked mode uses the current "Review the following changes." format.
- Token accounting: chunked mode always populates `ChunkedReviewResult` (with 1 chunk entry). Non-chunked returns plain `ReviewResult`.
- Stderr: chunked mode emits "Reviewing chunk 1/1 (...)" progress. Non-chunked emits "Requesting review...".
- The review content itself should be equivalent — same model, same diff, slightly different framing.

**Reduce pass token budget calculation:**

```
reducePromptTokens = reduceSystemPrompt.length / 4  (≈ 50 tokens, it's short)
findingsTokens = sum(chunkFindings[i].length / 4)    for all chunks
framingOverhead = 100 + (numChunks * 30)              chunk headers, instructions
                                                       (at 50 chunks this is ~1600 tokens —
                                                       significant but acceptable since 50-chunk
                                                       reviews are pathological. For the common
                                                       case of 2-5 chunks, overhead is 160-250 tokens.)
totalReduceInput = reducePromptTokens + findingsTokens + framingOverhead

reduceBudget = maxPromptTokens * 0.9   (leave 10% headroom for the model)
```

**Overflow handling** (when `totalReduceInput > reduceBudget`):

The reduce input can overflow in pathological cases — e.g., 50 chunks each producing 2000 tokens of findings = 100k tokens. Strategy uses **severity-aware truncation** to preserve high-priority findings:

1. Calculate available space: `available = reduceBudget - reducePromptTokens - framingOverhead`
2. For each chunk's findings, split into severity tiers by scanning for severity markers.
   Parser recognizes multiple formats to handle model output variance:
   - `### HIGH` / `### MEDIUM` / `### LOW` (default prompt format)
   - `[HIGH]` / `[MEDIUM]` / `[LOW]` (inline tag format)
   - `**HIGH**` / `**MEDIUM**` / `**LOW**` (bold format)
   - Case-insensitive matching (e.g., `### High` also matches)
   - Content before the first severity marker is treated as preamble (Tier 2 — MEDIUM).
   - If no severity markers found in a chunk's findings at all, treat entire chunk as Tier 2 (MEDIUM) — do not discard.
   Tiers:
   - **Tier 1 (preserve):** HIGH findings — never truncated
   - **Tier 2 (compress):** MEDIUM findings — truncated last
   - **Tier 3 (expendable):** LOW findings — truncated first
3. Truncation rounds (stop as soon as total fits within `available`):
   - **Round 1:** Remove LOW findings from all chunks, replace with `[{n} LOW findings omitted]`
   - **Round 2:** Truncate MEDIUM findings across chunks — for each MEDIUM finding:
     keep the title line (e.g., `2. **Missing null check in handler.ts:112**`) and first
     paragraph of description. Drop `**Suggestion:**` blocks and code samples.
     Target: ~30% of original per finding.
   - **Round 3:** If still over budget, reduce each MEDIUM finding to its title line only
     (one line per finding, ~10 tokens each). Append `[{n} MEDIUM findings compressed]`.
   - **Round 4 (last resort):** Proportional truncation of remaining content per chunk
4. Emit warning: `"Reduce pass: truncated findings to fit token budget (preserved all HIGH, {n} MEDIUM compressed, {m} LOW omitted)"`

This ensures HIGH findings are never lost. In the pathological case where HIGH findings alone exceed the budget, fall back to proportional truncation across all content with a warning.

**Truncation visibility in reduce pass:** When truncation occurs, the reduce input includes a preamble before the chunk findings:

```
Note: Some findings were truncated to fit the token budget.
Truncated chunks: [list of chunk numbers with truncation details].
Your aggregation should note that LOW/MEDIUM findings may be incomplete.
```

This ensures the reduce model knows content was dropped and can flag it in the final output. All truncation warnings are also collected in the `ReviewResult.warnings` array for the CLI/MCP caller.

**Phase 3: FORMAT — Same as current**

```
Take unified review from reduce pass (or single chunk findings).
Apply existing formatter (markdown/text/json).
Add metadata: model, total tokens across all rounds, chunk count, files reviewed.
For single-chunk reviews (reduce skipped), the output is identical to single-pass —
no "Chunks: 1" in the header, no chunkedBreakdown in JSON. The user sees no difference.
Multi-chunk reviews add chunk count to the header and chunkedBreakdown to JSON usage.
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
  chunked: true;                   // discriminant — lets consumers detect chunked results
  chunks: {
    files: string[];
    usage: { totalTokens: number };
  }[];
  reduceUsage: { totalTokens: number };
  // usage (inherited) = sum of all chunk + reduce tokens
}
```

**Backward compatibility for `usage.totalTokens`:** With chunked review, `totalTokens` is the sum across all map + reduce passes (2-3x higher than single-pass). This is semantically correct (it represents actual token consumption) but may surprise consumers who assume a single-pass cost.

Mitigations:
- The `chunked: true` discriminant lets JSON consumers detect and handle chunked results.
- In JSON output format, add `usage.chunkedBreakdown` alongside `usage.totalTokens`:
  ```json
  "usage": {
    "totalTokens": 12450,
    "chunkedBreakdown": { "mapTokens": 7950, "reduceTokens": 4500, "chunks": 3 }
  }
  ```
  `chunkedBreakdown` is only present when chunking occurred. Consumers that don't know about it see the same `totalTokens` field as before.
- In markdown/text format, the footer shows: `*Tokens used: 12,450 (3 chunks + aggregation) | Model: gpt-4.1*` — making the multi-pass nature visible.
- For single-pass reviews (the common case), `ReviewResult` is unchanged — no `chunked` field, no `chunkedBreakdown`.

### Streaming with Chunked Review

For `stream: true` with chunking enabled:

- **Map phase**: always **buffered** (non-streaming) — each chunk is a complete `provider.chat()` call. Between chunks, emit progress markers to **stderr only**: `"Reviewing chunk 2/5 (auth.ts, middleware.ts)..."`. Buffering the map phase is necessary because findings must be fully collected before the reduce pass. No output to stdout during map phase. This asymmetry (buffered map, streamed reduce) is deliberate — the map phase can't stream to the user because the output would be raw per-chunk findings (undeduped, no aggregation). Only the reduce output is user-facing.
- **Reduce phase**: **streamed** via `provider.chatStream()` — the final aggregated output streams to **stdout**. No stderr progress during reduce streaming (to avoid interleaving). A single stderr line before reduce starts: `"Aggregating findings..."`.

**stdout/stderr ordering:** All stderr progress writes use synchronous `process.stderr.write()` and complete before the next stdout write begins. During the reduce streaming phase, no stderr writes occur. This prevents interleaving in terminal output. In piped/CI environments, stderr and stdout go to separate file descriptors and never interleave at the OS level.
- **Mid-file hunk splits** (see Diff Splitting Step 4 for the algorithm): when a file is split across chunks at hunk boundaries, each chunk's progress marker includes the file path with a `(partial)` suffix: `"Reviewing chunk 3/5 (large-file.ts (partial), utils.ts)..."`

**Non-streaming chunked mode** (`stream: false`):

All phases (map + reduce) use `provider.chat()` (buffered). Progress markers emit to stderr between chunks (suppressed when `!process.stderr.isTTY` to avoid polluting CI logs — same pattern as the existing `progress()` helper in cli.ts). The final formatted result is returned as a single `ReviewResult` — same shape as the current single-pass buffered review. The caller (CLI/MCP) sees no difference in the return type, only in the stderr progress output and potentially richer token accounting.

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| Zero files in diff | No chunks, skip review |
| 1 file, fits in budget | Single pass — no chunking overhead |
| 1 file, exceeds budget | Hunk-level split → map-reduce |
| All files fit in 1 chunk | 1 chunk → skip reduce pass |
| 10 files, need 3 chunks | 3 map passes + 1 reduce |
| Reduce input exceeds budget | Truncate oldest chunk findings with warning |
| Provider error on chunk N | Each chunk call uses the provider's built-in retry logic (exponential backoff). If retries exhausted, fail entire review: "Review failed on chunk {n}/{total} (files: [...]): {cause}". No partial results, no resume. No checkpoint/resume mechanism in v1 — the user reruns the full review. Rationale: partial results without reduce aggregation are misleading, and checkpoint storage adds significant complexity for a scenario that's rare (transient errors are retried). |
| Empty chunk findings | Include in reduce with note "no issues found in chunk N" |
| Single hunk exceeds budget | Truncate hunk with warning, continue review |

### Example Chunked Review Output

For a diff spanning 8 files split into 3 chunks (markdown format):

```markdown
# LLM Code Review

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
├── review.ts       # Signature change (provider replaces client+models), chunk routing:
                    #   review() → resolveModel() → shouldChunk() decision →
                    #     if single-pass: singlePassReview() (existing logic, minor signature change)
                    #     if chunked: chunkDiff() → mapReview() → reduceReview() → format()
                    # Dependency flow (no circular deps):
                    #   review.ts imports: providers/types (interface), chunking, prompt, formatter, diff
                    #   chunking.ts imports: types only (pure function, no provider dependency)
                    #   providers/* imports: types, auth, streaming (no review dependency)
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
├── models.ts       # Logic splits:
                    #   - Model listing, filtering, dedup, policy enable → copilot-provider.ts
                    #   - ModelInfo type, validation logic → providers/types.ts (shared)
                    #   - Model caching (5-min TTL) → openai-chat-provider.ts (shared by all providers)
                    #   - Auto-select → copilot-provider.ts (Copilot-specific)
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
| Ollama model not found | `ModelError` | `model_not_found` | "Model '{id}' not found on Ollama. Run `llm-review models --provider ollama` to see available models." |
| No model specified, provider lacks auto-select | `ConfigError` | `model_required` | "Provider '{name}' requires an explicit model. Use --model or set in config." |
| Chunk N fails | `ReviewError` | `chunk_failed` | "Review failed on chunk {n}/{total} (files: [...]): {cause}" |
| Reduce pass fails | `ReviewError` | `reduce_failed` | "Aggregation pass failed: {cause}". Since map-phase findings were already collected, include them as a fallback: concatenate raw chunk findings with chunk headers, prepended with `"⚠ Aggregation failed — raw per-chunk findings below (may contain duplicates):\n\n"`. The formatter adds `(unaggregate)` to the output header. This is better than losing all work, and the explicit labeling prevents users from mistaking it for a clean review. |
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
8. maxPromptTokens <= 0        → throws ReviewError immediately
9. Token estimation overflow   → retry with reduced budget on context-length error
```

### Severity Marker Parsing Tests (must all be covered)

```
1. "### HIGH" / "### MEDIUM" / "### LOW" (default prompt format)
2. "[HIGH]" / "[MEDIUM]" / "[LOW]" (inline tag format)
3. "**HIGH**" / "**MEDIUM**" / "**LOW**" (bold format)
4. Case variations: "### high", "### High", "### HIGH"
5. Mixed formats within same chunk
6. No severity markers at all → entire chunk treated as MEDIUM
7. Content before first marker → treated as MEDIUM (preamble)
8. Marker at start of line vs mid-line (only start-of-line counts)
```

### Test Mocking Patterns

The `ReviewProvider` interface simplifies test mocking compared to the current setup (which requires mocking both `CopilotClient` and `ModelManager`):

```typescript
// Test helper: create a mock provider for unit tests
class MockProvider implements ReviewProvider {
  readonly name = "mock";

  // Configurable responses — override per test
  chatResponse: ChatResponse = { content: "No issues.", model: "mock", usage: { totalTokens: 10 } };
  streamChunks: StreamChunk[] | null = null;  // if set, chatStream yields these instead of splitting chatResponse
  models: ModelInfo[] = [{ id: "mock-model", name: "Mock", endpoints: ["/chat/completions"],
    streaming: true, toolCalls: false, maxPromptTokens: 128000, maxOutputTokens: 4096, tokenizer: "mock" }];
  healthResult: { ok: boolean; latencyMs: number | null; error?: string } = { ok: true, latencyMs: 1 };

  // Track calls for assertions
  chatCalls: ChatRequest[] = [];
  private _initialized = false;

  async initialize(): Promise<void> { this._initialized = true; }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.chatCalls.push(req);
    return this.chatResponse;
  }

  async *chatStream(req: ChatRequest): AsyncIterable<StreamChunk> {
    this.chatCalls.push(req);
    if (this.streamChunks) {
      // Use explicit stream chunks (for testing error chunks, custom sequences)
      for (const chunk of this.streamChunks) { yield chunk; }
      return;
    }
    // Default: split chatResponse content by words
    const words = (this.chatResponse.content || "").split(" ").filter(Boolean);
    for (const word of words) {
      yield { type: "content", text: word + " " };
    }
    yield { type: "done", usage: this.chatResponse.usage, model: this.chatResponse.model };
  }

  async listModels(): Promise<ModelInfo[]> { return this.models; }
  async validateModel(id: string): Promise<ModelInfo> {
    const m = this.models.find(m => m.id === id);
    if (!m) throw new ModelError("model_not_found", `Model '${id}' not found`, false);
    return m;
  }
  async healthCheck() { return this.healthResult; }
  dispose(): void { this._initialized = false; }
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
- **Project rename** — `llm-review` → provider-neutral name.
- **Anthropic provider** — implement `ReviewProvider` directly (non-OpenAI protocol).
- **Config migration tooling** — `llm-review migrate-config` to move `~/.llm-review/` → `~/.llm-reviewer/` with deprecation warnings when old paths are detected.
- **File/directory scoped review** — `llm-review local --path src/lib/auth.ts` or `--path src/lib/` to review only specific files or directories, filtering the diff to matching paths before sending to the provider.

---

## 10. Implementation Notes

Items that are real concerns but better addressed during implementation than in this spec. Captured here so they aren't lost.

- **Token estimation accuracy** — the `char / 4` heuristic is a rough estimate. During implementation, validate against a few real diffs and adjust the multiplier or add a safety margin if needed. A proper BPE tokenizer is out of scope for v1 (see spec 01 — "Notably Absent").
- **Message framing overhead constants** (150 tokens, 10 per-file) — derived from measuring a few representative prompts. Validate during implementation and adjust if empirical testing shows they're off.
- **Path normalization for bin-packing** — file paths from `git diff` use forward slashes on all platforms. No cross-platform normalization needed for the sort/tie-breaking since git normalizes paths. Verify during implementation on Windows (Git Bash).
- **Hunk truncation warning actionability** — for models already at max context, the "use a larger-context model" suggestion isn't helpful. Implementation should detect this and adjust the message to "split this file into smaller changes" instead.
- **Config migration path for existing users** — the fallback mechanism handles this silently. If user feedback indicates confusion, add a one-time migration notice in a future release.
- **Provider retry policy consistency** — ensure `OllamaProvider.shouldRetry()` and `CopilotProvider.shouldRetry()` are tested with the same error scenarios to verify no gaps.
- **Session token cache expiry mid-review** — for long chunked reviews (10+ minutes), the Copilot session token may expire between chunks. The existing auth.ts refresh logic handles this transparently (re-exchanges on 401), but verify with a test that simulates expiry mid-pipeline.
- **Responses API fallback flag as shared mutable state** — the per-model fallback Map is written during sequential chunk processing (no concurrent writes). If parallel chunk execution is added later (Section 9), this needs a concurrent-safe structure.
- **autoSelect() vs listModels() cache race** — autoSelect() returns a model ID that must exist in listModels(). Both are called sequentially (auto-select, then validate via listModels). If the model list changes between calls (model removed), validateModel throws ModelError. This is acceptable — it's a transient error the user can retry.
- **File manifest in user message may affect downstream message parsers** — the markdown table format is standard and shouldn't break anything, but test with MCP consumers that parse the review content.
