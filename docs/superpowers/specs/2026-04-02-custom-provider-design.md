# Design: Custom Provider (OpenAI-compatible)

**Date:** 2026-04-02
**Status:** Approved

## Summary

Add a `custom` provider that connects to any OpenAI-compatible endpoint. Users supply a base URL, optional auth (static key or shell command), and a model name. Supports named configurations for multiple endpoints (e.g., `custom:groq`, `custom:openrouter`).

## Motivation

The project supports Copilot and Ollama as providers. Users who want to use other LLM services (OpenRouter, Groq, Together AI, Fireworks, Vertex AI, LM Studio, vLLM, etc.) have no path today. Most of these services expose an OpenAI-compatible Chat Completions API, so a single generic provider covers them all.

## Design Decisions

### Provider naming: `custom` with optional suffix

- `--provider custom` — bare custom provider
- `--provider custom:<name>` — named custom provider, reads config from `providerOptions.<name>`
- The `custom:` prefix prevents collision with built-in provider names (`copilot`, `ollama`)
- Unknown provider names (without `custom:` prefix) produce a `ConfigError`

### Bare `custom` resolution

When `--provider custom` is used (no suffix):

1. If `--base-url` CLI flag or `LLM_REVIEWER_BASE_URL` env var is set, use those (CLI/env override)
2. Else, find the **first** entry in `providerOptions` that is not a built-in provider name (`copilot`, `ollama`) and use it
3. If nothing found, throw `ConfigError`

### Auth: cache-until-failure

- Auth key is cached in memory for the session
- On 401 response (or 403 without `x-ratelimit-reset` header): invalidate cache, re-run key command, retry once
- 403 with `x-ratelimit-reset` header: skip refresh, delegate to base class rate-limit handling
- Second auth failure after refresh: throw `AuthError` for 401, `ClientError` for 403 (no loop)
- If no key and no command configured: no `Authorization` header (supports unauthenticated local endpoints)

### Explicit model required

Model must always be specified explicitly via `--model` or config file `model` field. There is no auto-select for custom providers. If `model` is `"auto"` (the default) and the provider has no `autoSelect()`, the review flow must throw a clear `ConfigError`:
> "Custom provider requires an explicit model. Set --model or add \"model\": \"<name>\" to your config."

### No `autoSelect()`

See "Explicit model required" above.

### `listModels()`: best-effort

- Attempts `GET <baseUrl>/models` and parses OpenAI-style response (`{ data: [...] }`)
- On any failure (network, non-200, unexpected format): returns empty array, no error
- `llm-reviewer models --provider custom:groq` works if the endpoint supports it, silently returns nothing if it doesn't

## Implementation

### New file: `src/lib/providers/custom-provider.ts`

Extends `OpenAIChatProvider` (~150 lines).

```typescript
class CustomProvider extends OpenAIChatProvider {
  readonly name: string; // "custom" or "custom:<suffix>"

  // Auth
  private _apiKey: string | null;
  private _apiKeyCommand: string | null;
  private _cachedKey: string | null = null;
  private _keyRefreshed = false;

  constructor(
    name: string,
    baseUrl: string,
    auth: { apiKey?: string; apiKeyCommand?: string },
    timeoutSeconds?: number
  );

  protected async getHeaders(): Promise<Record<string, string>>;
  // Returns { Authorization: "Bearer <key>" } or {} if no auth

  async listModels(): Promise<ModelInfo[]>;
  // GET <baseUrl>/models, parse data[], return [] on failure

  override async healthCheck(): Promise<{ ok: boolean; latencyMs: number | null; error?: string }>;
  // Inherited from OpenAIChatProvider (GET baseUrl)

  override dispose(): void;
  // Zero out _cachedKey

  // Key refresh: override handleErrorResponse to invalidate cache on 401/403
  // and set _keyRefreshed flag. If already refreshed, throw AuthError.
}
```

**Key resolution in `getHeaders()`:**

```
1. If _cachedKey is set -> use it
2. If static apiKey provided -> cache and use
3. If apiKeyCommand provided -> shell exec, capture stdout, trim, cache, use
4. None -> return {} (no auth header)
```

**Key refresh on auth failure:**

Override `handleErrorResponse()`. On 401, or 403 without `x-ratelimit-reset` header:
- If `_apiKeyCommand` is set and `_keyRefreshed` is false:
  - Set `_cachedKey = null`, re-run command to populate `_cachedKey`
  - Only if command succeeds: set `_keyRefreshed = true`
  - If command fails: fall through to `super.handleErrorResponse()`
  - Throw a **recoverable** `ClientError` (code `"auth_refresh"`)
  - The existing `retry()` loop in `OpenAIChatProvider` will re-attempt the request,
    which calls `getHeaders()` again, picking up the refreshed key
- If `_keyRefreshed` is already true (second failure after refresh):
  - Fall through to `super.handleErrorResponse()` which throws `AuthError` for 401, `ClientError` for 403
- `_keyRefreshed` is reset to `false` at the START of both `chat()` and `chatStream()` calls
  (not after success — this avoids the chatStream-never-resets problem since chatStream is not retried)

Note: `shouldRetry()` must be overridden to treat `"auth_refresh"` as retryable.

**Concurrent key resolution:**

`_resolveKey()` must coalesce concurrent calls. Use a `_keyFetchPromise` field:
- If `_keyFetchPromise` is non-null, await it instead of re-executing the command
- Set `_keyFetchPromise` before executing, clear it in `finally`

**Key resolution precedence within the provider:**

The `CustomProvider` constructor receives pre-resolved auth from the factory. The factory
resolves auth using this precedence (env vars override config file values):
1. `LLM_REVIEWER_API_KEY` env var → `apiKey`
2. `LLM_REVIEWER_API_KEY_COMMAND` env var → `apiKeyCommand`
3. `providerOptions.<name>.apiKey` → `apiKey`
4. `providerOptions.<name>.apiKeyCommand` → `apiKeyCommand`

When both `apiKey` and `apiKeyCommand` are present, `apiKeyCommand` wins (dynamic over static).
The factory resolves this precedence — provider receives EITHER `apiKey` OR `apiKeyCommand`, never both.

### Factory changes: `src/lib/providers/index.ts`

```typescript
const BUILTIN_PROVIDERS: Record<string, ProviderFactory> = {
  copilot: (config) => ...,
  ollama: (config) => ...,
};

// In constructProvider():
// 1. Check BUILTIN_PROVIDERS[name]
// 2. If name starts with "custom:" -> extract suffix, look up providerOptions[suffix]
// 3. If name == "custom" -> resolve from CLI/env or first non-builtin providerOptions entry
// 4. Else -> ConfigError
```

### Config types: `src/lib/types.ts`

```typescript
interface ConfigFile {
  providerOptions?: {
    ollama?: { baseUrl?: string };
    [key: string]: {
      baseUrl?: string;
      apiKey?: string;
      apiKeyCommand?: string;
    } | undefined;
  };
}
```

The `[key: string]` index signature already exists. `CustomProvider` reads `baseUrl`, `apiKey`, `apiKeyCommand` from the matched entry.

### Timeout default

Custom providers keep the default 30s timeout (same as Copilot). Cloud APIs are fast; users
deploying local models should set `--timeout 120` or `"timeout": 120` in config.
No blanket 120s override — that penalizes cloud API users with unnecessary wait on timeouts.

### CLI changes: `src/cli.ts`

- Add `--base-url <url>` flag to `review`, `models`, `status` commands
- Add `LLM_REVIEWER_BASE_URL`, `LLM_REVIEWER_API_KEY`, `LLM_REVIEWER_API_KEY_COMMAND` env var support in config resolution
- Update `--provider` help text: `"Review provider: copilot, ollama, custom, custom:<name>"`

### CLIOverrides: `src/lib/types.ts`

```typescript
interface CLIOverrides {
  // existing fields...
  baseUrl?: string;  // new
}
```

### Env var precedence (key)

1. `LLM_REVIEWER_API_KEY` env var (static)
2. `LLM_REVIEWER_API_KEY_COMMAND` env var (dynamic)
3. `providerOptions.<name>.apiKey` (static, config file)
4. `providerOptions.<name>.apiKeyCommand` (dynamic, config file)
5. No auth

### Env var precedence (baseUrl)

1. `--base-url` CLI flag
2. `LLM_REVIEWER_BASE_URL` env var
3. `providerOptions.<name>.baseUrl` (config file)
4. `ConfigError` — required, no default

## Security

### Config file trust model

- **Global config** (`~/.llm-reviewer/`) is trusted — you wrote it.
- **Project config** (`<git-root>/.llm-reviewer/`) is treated as CODE — review before running in untrusted repos.
- `apiKeyCommand` executes shell commands with full user permissions. Treat it like `package.json` scripts.
- Do NOT store static `apiKey` in project config files that may be committed to version control. Prefer `apiKeyCommand` or `LLM_REVIEWER_API_KEY` env var.
- Keys must never appear in error messages or logs. Use redaction for any key-adjacent error output.
- `apiKeyCommand` strings must NOT appear in error messages — the command may contain embedded secrets (e.g., `echo $SECRET_VAR`, credential paths). Show only error context ("command failed", "empty output"), never the command itself.

### baseUrl note

Custom provider expects the full base URL including the path prefix (e.g., `https://api.groq.com/openai/v1`).
This differs from `OllamaProvider` which takes a root URL and appends `/v1` internally.
If requests fail with 404, check that baseUrl includes `/v1` or the provider's equivalent path.

## Documentation

### Popular OpenAI-compatible endpoints (for README)

| Provider | Base URL | Auth | Model examples |
|----------|----------|------|----------------|
| OpenRouter | `https://openrouter.ai/api/v1` | Bearer key from openrouter.ai/keys | `google/gemini-2.5-flash`, `anthropic/claude-sonnet-4` |
| Groq | `https://api.groq.com/openai/v1` | Bearer key from console.groq.com | `llama-3.3-70b-versatile`, `mixtral-8x7b-32768` |
| Together AI | `https://api.together.xyz/v1` | Bearer key from together.ai | `meta-llama/Llama-3.3-70B-Instruct-Turbo` |
| Fireworks | `https://api.fireworks.ai/inference/v1` | Bearer key from fireworks.ai | `accounts/fireworks/models/llama-v3p3-70b-instruct` |
| Ollama (via custom) | `http://localhost:11434/v1` | None | `llama3.3`, `codellama` |
| LM Studio | `http://localhost:1234/v1` | None | Whatever model is loaded |
| vLLM | `http://localhost:8000/v1` | None | Depends on deployment |

### Usage examples

```bash
# OpenRouter with env var
LLM_REVIEWER_API_KEY="sk-or-..." llm-reviewer review \
  --provider custom --base-url https://openrouter.ai/api/v1 \
  --model google/gemini-2.5-flash

# Named provider from config
llm-reviewer review --provider custom:groq --model llama-3.3-70b-versatile

# Dynamic auth with apiKeyCommand
# Config: { "providerOptions": { "gcp": { "baseUrl": "https://...", "apiKeyCommand": "gcloud auth print-access-token" } } }
llm-reviewer review --provider custom:gcp --model gemini-2.5-flash

# Bare custom with first providerOptions entry
llm-reviewer review --provider custom --model google/gemini-2.5-flash
```

## Testing

### Unit tests (`custom-provider.test.ts`)

- **`getHeaders()`**: static key, command key, no key, command failure (non-zero exit)
- **Key refresh**: 401 triggers command re-exec, second 401 throws AuthError
- **`listModels()`**: successful OpenAI-style parse, endpoint error (returns []), non-standard response (returns [])
- **`initialize()`**: validates baseUrl is present
- **`dispose()`**: zeroes cached key

### Config resolution tests

- Precedence: env var > config file for both key and baseUrl
- `custom:name` resolves correct providerOptions entry
- Bare `custom` picks first non-builtin entry
- Missing baseUrl throws ConfigError

### Integration test

- Point `CustomProvider` at local Ollama `/v1` endpoint
- Verify chat and streaming work end-to-end

## Files changed

| File | Change |
|------|--------|
| `src/lib/providers/custom-provider.ts` | New (~180 lines) |
| `test/lib/providers/custom-provider.test.ts` | New — unit tests |
| `src/lib/providers/index.ts` | Add custom provider factory + `custom:` prefix parsing + apiKey/apiKeyCommand precedence |
| `test/lib/providers/index.test.ts` | Add factory tests for custom provider |
| `src/lib/types.ts` | Add `baseUrl` to `CLIOverrides` |
| `src/lib/config.ts` | Handle `LLM_REVIEWER_API_KEY`, `LLM_REVIEWER_API_KEY_COMMAND`, `LLM_REVIEWER_BASE_URL` env vars; suppress unknown providerOptions warning for custom entries |
| `test/lib/config.test.ts` | Add tests for new env vars and CLI override |
| `src/cli.ts` | Add `--base-url` flag, update `--provider` help text |
| `README.md` | Custom provider docs, endpoint reference table, security notes, usage examples |
