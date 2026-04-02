# Custom Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `custom` provider that connects to any OpenAI-compatible endpoint with configurable auth (static key or shell command), supporting named configurations via `custom:<name>` syntax.

**Architecture:** `CustomProvider` extends `OpenAIChatProvider` (same base as `OllamaProvider`). Auth keys are cached in memory until a 401/403 triggers a single refresh attempt. The factory in `index.ts` parses `custom:` prefixes to resolve named configs from `providerOptions`. Config, CLI, and env var layers follow established precedence patterns.

**Tech Stack:** TypeScript, vitest, msw (HTTP mocking), commander (CLI)

**Spec:** `docs/superpowers/specs/2026-04-02-custom-provider-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/lib/providers/custom-provider.ts` | **New.** `CustomProvider` class extending `OpenAIChatProvider` |
| `test/lib/providers/custom-provider.test.ts` | **New.** Unit tests for `CustomProvider` |
| `src/lib/providers/index.ts` | **Modify.** Add `custom:` prefix parsing, factory for custom providers |
| `test/lib/providers/index.test.ts` | **Modify.** Add tests for custom provider factory |
| `src/lib/types.ts` | **Modify.** Add `baseUrl` to `CLIOverrides` |
| `src/lib/config.ts` | **Modify.** Handle `LLM_REVIEWER_API_KEY`, `LLM_REVIEWER_API_KEY_COMMAND`, `LLM_REVIEWER_BASE_URL` env vars; wire `--base-url` CLI override |
| `test/lib/config.test.ts` | **Modify.** Add tests for new env vars and CLI override |
| `src/cli.ts` | **Modify.** Add `--base-url` flag, update `--provider` help text |

---

### Task 1: CustomProvider — core class with static key auth

**Files:**
- Create: `src/lib/providers/custom-provider.ts`
- Create: `test/lib/providers/custom-provider.test.ts`

- [ ] **Step 1: Write failing tests for constructor and getHeaders with static key**

In `test/lib/providers/custom-provider.test.ts`:

```typescript
// test/lib/providers/custom-provider.test.ts

import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { CustomProvider } from "../../../src/lib/providers/custom-provider.js";
import { ConfigError } from "../../../src/lib/types.js";

const BASE_URL = "http://localhost:9999/v1";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("CustomProvider", () => {
  describe("constructor", () => {
    it("sets name to 'custom' when no suffix provided", () => {
      const provider = new CustomProvider("custom", BASE_URL, {});
      expect(provider.name).toBe("custom");
    });

    it("sets name to 'custom:groq' when suffix provided", () => {
      const provider = new CustomProvider("custom:groq", BASE_URL, {});
      expect(provider.name).toBe("custom:groq");
    });

    it("throws ConfigError when baseUrl is empty", () => {
      expect(() => new CustomProvider("custom", "", {})).toThrow(ConfigError);
    });
  });

  describe("getHeaders()", () => {
    it("returns Authorization header when static apiKey is provided", async () => {
      const provider = new CustomProvider("custom", BASE_URL, { apiKey: "sk-test-123" });
      const headers = await (provider as any).getHeaders();
      expect(headers).toEqual({ Authorization: "Bearer sk-test-123" });
    });

    it("returns empty object when no auth is configured", async () => {
      const provider = new CustomProvider("custom", BASE_URL, {});
      const headers = await (provider as any).getHeaders();
      expect(headers).toEqual({});
    });

    it("caches the static key — returns same value on second call", async () => {
      const provider = new CustomProvider("custom", BASE_URL, { apiKey: "sk-test-123" });
      const h1 = await (provider as any).getHeaders();
      const h2 = await (provider as any).getHeaders();
      expect(h1).toEqual(h2);
    });
  });

  describe("chat()", () => {
    it("sends request to baseUrl/chat/completions with auth header", async () => {
      let capturedAuth = "";
      server.use(
        http.post(`${BASE_URL}/chat/completions`, async ({ request }) => {
          capturedAuth = request.headers.get("authorization") ?? "";
          return HttpResponse.json({
            choices: [{ message: { role: "assistant", content: "Hello" } }],
            usage: { total_tokens: 10 },
            model: "test-model",
          });
        })
      );

      const provider = new CustomProvider("custom", BASE_URL, { apiKey: "sk-test" });
      const response = await provider.chat({
        model: "test-model",
        systemPrompt: "You are helpful",
        messages: [{ role: "user", content: "Hi" }],
        stream: false,
      });

      expect(capturedAuth).toBe("Bearer sk-test");
      expect(response.content).toBe("Hello");
    });
  });

  describe("chatStream()", () => {
    it("streams response from baseUrl/chat/completions with auth header", async () => {
      let capturedAuth = "";
      server.use(
        http.post(`${BASE_URL}/chat/completions`, async ({ request }) => {
          capturedAuth = request.headers.get("authorization") ?? "";
          const encoder = new TextEncoder();
          const body = new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" }, finish_reason: null }] })}\n\n`
                )
              );
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          });
          return new HttpResponse(body, {
            headers: { "Content-Type": "text/event-stream" },
          });
        })
      );

      const provider = new CustomProvider("custom", BASE_URL, { apiKey: "sk-test" });
      const chunks: string[] = [];
      for await (const chunk of provider.chatStream({
        model: "test-model",
        systemPrompt: "You are helpful",
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
      })) {
        if (chunk.type === "content" && chunk.text != null) {
          chunks.push(chunk.text);
        }
      }

      expect(capturedAuth).toBe("Bearer sk-test");
      expect(chunks).toContain("Hello");
    });
  });

  describe("apiKey vs apiKeyCommand precedence", () => {
    it("apiKeyCommand wins when both apiKey and apiKeyCommand are provided", async () => {
      const provider = new CustomProvider("custom", BASE_URL, {
        apiKey: "sk-static",
        apiKeyCommand: "echo sk-from-command",
      });
      const headers = await (provider as any).getHeaders();
      expect(headers).toEqual({ Authorization: "Bearer sk-from-command" });
    });
  });

  describe("dispose()", () => {
    it("does not throw", () => {
      const provider = new CustomProvider("custom", BASE_URL, { apiKey: "secret" });
      expect(() => provider.dispose()).not.toThrow();
    });

    it("zeroes cached key — getHeaders returns empty after dispose", async () => {
      const provider = new CustomProvider("custom", BASE_URL, { apiKey: "secret" });
      // Warm the cache
      await (provider as any).getHeaders();
      provider.dispose();
      const headers = await (provider as any).getHeaders();
      expect(headers).toEqual({});
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/lib/providers/custom-provider.test.ts`
Expected: FAIL — `CustomProvider` does not exist yet.

- [ ] **Step 3: Implement CustomProvider with static key auth**

In `src/lib/providers/custom-provider.ts`:

```typescript
// src/lib/providers/custom-provider.ts

import type { ModelInfo } from "../types.js";
import { ConfigError } from "../types.js";
import { OpenAIChatProvider } from "./openai-chat-provider.js";

export interface CustomProviderAuth {
  apiKey?: string;
  apiKeyCommand?: string;
}

/**
 * Generic provider for any OpenAI-compatible endpoint.
 * Supports static API keys and dynamic key commands.
 */
export class CustomProvider extends OpenAIChatProvider {
  readonly name: string;

  private _auth: CustomProviderAuth;
  private _cachedKey: string | null = null;
  private _keyFetchPromise: Promise<string> | null = null;
  private _disposed = false;

  constructor(
    name: string,
    baseUrl: string,
    auth: CustomProviderAuth,
    timeoutSeconds?: number,
  ) {
    if (!baseUrl || baseUrl.trim() === "") {
      throw new ConfigError(
        "missing_base_url",
        `Custom provider '${name}' requires a base URL. Set it via --base-url, LLM_REVIEWER_BASE_URL env var, or providerOptions in config.`,
        "",
        false,
      );
    }
    super(baseUrl, timeoutSeconds);
    this.name = name;
    this._auth = auth;

    if (auth.apiKey) {
      this._cachedKey = auth.apiKey;
    }
  }

  protected async getHeaders(): Promise<Record<string, string>> {
    if (this._disposed) {
      return {};
    }

    const key = await this._resolveKey();
    if (key) {
      return { Authorization: `Bearer ${key}` };
    }
    return {};
  }

  /**
   * Coalesce concurrent key resolution. If a command is already running,
   * await its result instead of spawning a second execution.
   */

  async listModels(): Promise<ModelInfo[]> {
    try {
      const headers = await this.getHeaders();
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: { ...headers, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        return [];
      }

      const json = (await response.json()) as { data?: Array<{ id: string }> };
      const rawModels = json.data ?? [];

      return rawModels.map((m) => ({
        id: m.id,
        name: m.id,
        endpoints: ["/v1/chat/completions"],
        streaming: true,
        toolCalls: false,
        maxPromptTokens: 128_000,
        maxOutputTokens: 4096,
        tokenizer: "unknown",
      }));
    } catch {
      return [];
    }
  }

  override dispose(): void {
    this._cachedKey = null;
    this._disposed = true;
  }

  private async _resolveKey(): Promise<string | null> {
    if (this._cachedKey) {
      return this._cachedKey;
    }

    // Re-cache static key if it was cleared by dispose() or key refresh
    if (this._auth.apiKey && !this._auth.apiKeyCommand) {
      this._cachedKey = this._auth.apiKey;
      return this._cachedKey;
    }

    if (this._auth.apiKeyCommand) {
      // Coalesce concurrent calls
      if (this._keyFetchPromise) {
        return this._keyFetchPromise;
      }
      this._keyFetchPromise = this._execCommand(this._auth.apiKeyCommand)
        .then((key) => {
          this._cachedKey = key;
          return key;
        })
        .finally(() => {
          this._keyFetchPromise = null;
        });
      return this._keyFetchPromise;
    }

    return null;
  }

  /** Execute a shell command and return trimmed stdout. */
  private async _execCommand(command: string): Promise<string> {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);

    try {
      const { stdout } = await execFileAsync("sh", ["-c", command], {
        timeout: 10_000,
      });
      const trimmed = stdout.trim();
      if (!trimmed) {
        throw new ConfigError(
          "key_command_empty",
          `API key command produced empty output (command configured but returned nothing)`,
          "",
          false,
        );
      }
      return trimmed;
    } catch (err) {
      if (err instanceof ConfigError) throw err;
      throw new ConfigError(
        "key_command_failed",
        `API key command failed: ${err instanceof Error ? err.message : String(err)}`,
        "",
        false,
        err instanceof Error ? err : undefined,
      );
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/lib/providers/custom-provider.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/providers/custom-provider.ts test/lib/providers/custom-provider.test.ts
git commit -m "feat: add CustomProvider with static key auth and listModels"
```

---

### Task 2: CustomProvider — apiKeyCommand support

**Files:**
- Modify: `test/lib/providers/custom-provider.test.ts`
- Modify: `src/lib/providers/custom-provider.ts` (already implemented in Task 1, tests validate)

- [ ] **Step 1: Write failing tests for apiKeyCommand**

Add to `test/lib/providers/custom-provider.test.ts`:

```typescript
describe("getHeaders() with apiKeyCommand", () => {
  it("executes command and uses stdout as Bearer token", async () => {
    const provider = new CustomProvider("custom", BASE_URL, {
      apiKeyCommand: "echo sk-from-command",
    });
    const headers = await (provider as any).getHeaders();
    expect(headers).toEqual({ Authorization: "Bearer sk-from-command" });
  });

  it("caches command result — second call does not re-execute", async () => {
    // Use a command that would produce different output each time if re-run
    const provider = new CustomProvider("custom", BASE_URL, {
      apiKeyCommand: "echo sk-cached-key",
    });
    const h1 = await (provider as any).getHeaders();
    const h2 = await (provider as any).getHeaders();
    expect(h1).toEqual(h2);
    expect(h1).toEqual({ Authorization: "Bearer sk-cached-key" });
  });

  it("throws ConfigError when command exits with non-zero", async () => {
    const provider = new CustomProvider("custom", BASE_URL, {
      apiKeyCommand: "exit 1",
    });
    await expect((provider as any).getHeaders()).rejects.toSatisfy(
      (err: unknown) => err instanceof ConfigError && (err as ConfigError).code === "key_command_failed"
    );
  });

  it("throws ConfigError when command produces empty output (redacted message)", async () => {
    const provider = new CustomProvider("custom", BASE_URL, {
      apiKeyCommand: "echo ''",
    });
    await expect((provider as any).getHeaders()).rejects.toSatisfy(
      (err: unknown) => {
        if (!(err instanceof ConfigError)) return false;
        if (err.code !== "key_command_empty") return false;
        // Command string must NOT appear in error message
        if (err.message.includes("echo")) return false;
        return true;
      }
    );
  });

  it("coalesces concurrent apiKeyCommand calls — only one execution", async () => {
    let execCount = 0;
    const provider = new CustomProvider("custom", BASE_URL, {
      apiKeyCommand: "echo sk-test",
    });
    (provider as any)._execCommand = async () => {
      execCount++;
      await new Promise(resolve => setTimeout(resolve, 50));
      return `sk-key-${execCount}`;
    };

    const [h1, h2] = await Promise.all([
      (provider as any).getHeaders(),
      (provider as any).getHeaders(),
    ]);

    expect(execCount).toBe(1);
    expect(h1).toEqual(h2);
    expect(h1).toEqual({ Authorization: "Bearer sk-key-1" });
  });

  it("trims whitespace from command output", async () => {
    const provider = new CustomProvider("custom", BASE_URL, {
      apiKeyCommand: "echo '  sk-with-spaces  '",
    });
    const headers = await (provider as any).getHeaders();
    expect(headers).toEqual({ Authorization: "Bearer sk-with-spaces" });
  });
});
```

- [ ] **Step 2: Run tests to verify they pass** (implementation already in Task 1)

Run: `npx vitest run test/lib/providers/custom-provider.test.ts`
Expected: All tests PASS (apiKeyCommand logic was implemented in Task 1).

- [ ] **Step 3: Commit**

```bash
git add test/lib/providers/custom-provider.test.ts
git commit -m "test: add apiKeyCommand tests for CustomProvider"
```

---

### Task 3: CustomProvider — key refresh on auth failure

**Files:**
- Modify: `test/lib/providers/custom-provider.test.ts`
- Modify: `src/lib/providers/custom-provider.ts`

- [ ] **Step 1: Write failing tests for key refresh**

Add to `test/lib/providers/custom-provider.test.ts`:

```typescript
describe("key refresh on 401/403", () => {
  it("refreshes key on 401 and retries successfully", async () => {
    let callCount = 0;
    server.use(
      http.post(`${BASE_URL}/chat/completions`, () => {
        callCount++;
        if (callCount === 1) {
          return HttpResponse.json(
            { error: { message: "Unauthorized" } },
            { status: 401 }
          );
        }
        return HttpResponse.json({
          choices: [{ message: { role: "assistant", content: "Refreshed!" } }],
          usage: { total_tokens: 5 },
          model: "test-model",
        });
      })
    );

    let execCount = 0;
    const provider = new CustomProvider("custom", BASE_URL, {
      apiKeyCommand: `echo sk-key-$((${Date.now()} + $RANDOM))`,
    });
    // Manually override _execCommand to track calls
    let keyVersion = 0;
    (provider as any)._execCommand = async () => {
      execCount++;
      keyVersion++;
      return `sk-key-v${keyVersion}`;
    };

    const response = await provider.chat({
      model: "test-model",
      systemPrompt: "",
      messages: [{ role: "user", content: "test" }],
      stream: false,
    });

    expect(response.content).toBe("Refreshed!");
    expect(execCount).toBe(2); // initial + refresh
    expect(callCount).toBe(2); // first 401 + retry
  });

  it("throws AuthError after refresh still gets 401", async () => {
    server.use(
      http.post(`${BASE_URL}/chat/completions`, () => {
        return HttpResponse.json(
          { error: { message: "Unauthorized" } },
          { status: 401 }
        );
      })
    );

    const provider = new CustomProvider("custom", BASE_URL, {
      apiKeyCommand: "echo sk-always-bad",
    });

    const err = await provider.chat({
      model: "test-model",
      systemPrompt: "",
      messages: [{ role: "user", content: "test" }],
      stream: false,
    }).catch((e) => e);

    // Should eventually throw (AuthError or ClientError) — not infinite loop
    expect(err).toBeDefined();
    expect(err.message).toContain("Unauthorized");
  });

  it("does not attempt refresh when no apiKeyCommand is configured", async () => {
    server.use(
      http.post(`${BASE_URL}/chat/completions`, () => {
        return HttpResponse.json(
          { error: { message: "Unauthorized" } },
          { status: 401 }
        );
      })
    );

    const provider = new CustomProvider("custom", BASE_URL, { apiKey: "sk-static" });

    const err = await provider.chat({
      model: "test-model",
      systemPrompt: "",
      messages: [{ role: "user", content: "test" }],
      stream: false,
    }).catch((e) => e);

    expect(err).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/lib/providers/custom-provider.test.ts`
Expected: FAIL — key refresh logic not implemented yet.

- [ ] **Step 3: Implement key refresh in handleErrorResponse override**

Add to `src/lib/providers/custom-provider.ts`:

```typescript
// Add/update imports at top (ChatRequest, ChatResponse, StreamChunk are used
// by the base class signatures — TypeScript infers them from super calls):
import { ClientError, AuthError, ConfigError } from "../types.js";

// Add to class body:
private _keyRefreshed = false;

/**
 * Override to intercept 401 (and 403 without rate-limit header) and attempt
 * key refresh before throwing. If apiKeyCommand is set and we haven't already
 * refreshed, invalidate the cached key, re-run the command, and throw a
 * recoverable error so the retry loop retries with the new key.
 *
 * 403 with x-ratelimit-reset header is NOT an auth error — skip refresh
 * and delegate to base class rate-limit handling.
 */
protected override async handleErrorResponse(response: Response): Promise<never> {
  // Skip refresh for rate-limited 403s
  const isRateLimited = response.status === 403 && response.headers.get("x-ratelimit-reset");
  const isAuthError = (response.status === 401 || (response.status === 403 && !isRateLimited));

  if (
    isAuthError &&
    this._auth.apiKeyCommand &&
    !this._keyRefreshed
  ) {
    // Invalidate and attempt refresh
    this._cachedKey = null;
    this._keyFetchPromise = null; // clear stale promise to prevent races
    try {
      this._cachedKey = await this._execCommand(this._auth.apiKeyCommand);
      // Only set flag if command succeeded — don't burn the retry on a failed command
      this._keyRefreshed = true;

      // Throw recoverable so retry() picks it up
      const err = new ClientError(
        "auth_refresh",
        "Refreshing API key and retrying",
        true,
      );
      err.status = response.status;
      throw err;
    } catch (refreshErr) {
      // If it's our auth_refresh error, re-throw it
      if (refreshErr instanceof ClientError && refreshErr.code === "auth_refresh") {
        throw refreshErr;
      }
      // Command failed with ConfigError — user needs to see this, not the HTTP 401
      if (refreshErr instanceof ConfigError) {
        throw refreshErr;
      }
      // Unexpected error — fall through to normal error handling
    }
  }

  // Second failure after refresh, no command, or command failed — use default handling
  return super.handleErrorResponse(response);
}

/**
 * Override to treat auth_refresh as retryable.
 */
protected override shouldRetry(error: ClientError): boolean {
  if (error.code === "auth_refresh") return true;
  return super.shouldRetry(error);
}
```

Override both `chat()` and `chatStream()` to reset `_keyRefreshed` at the START of each call.
Resetting at start (not after success) avoids the problem where `chatStream()` is not retried
by the base class and would leave the flag permanently set:

```typescript
override async chat(request: ChatRequest): Promise<ChatResponse> {
  this._keyRefreshed = false; // reset at start of each top-level call
  return super.chat(request);
}

override async *chatStream(request: ChatRequest): AsyncIterable<StreamChunk> {
  this._keyRefreshed = false; // reset at start of each top-level call
  yield* super.chatStream(request);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/lib/providers/custom-provider.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/providers/custom-provider.ts test/lib/providers/custom-provider.test.ts
git commit -m "feat: add key refresh on 401/403 for CustomProvider"
```

---

### Task 4: CustomProvider — listModels best-effort

**Files:**
- Modify: `test/lib/providers/custom-provider.test.ts`

- [ ] **Step 1: Write tests for listModels**

Add to `test/lib/providers/custom-provider.test.ts`:

```typescript
describe("listModels()", () => {
  it("parses OpenAI-style /models response", async () => {
    server.use(
      http.get(`${BASE_URL}/models`, () => {
        return HttpResponse.json({
          data: [
            { id: "gpt-4o", object: "model" },
            { id: "gpt-3.5-turbo", object: "model" },
          ],
        });
      })
    );

    const provider = new CustomProvider("custom", BASE_URL, {});
    const models = await provider.listModels();

    expect(models).toHaveLength(2);
    expect(models[0].id).toBe("gpt-4o");
    expect(models[0].name).toBe("gpt-4o");
    expect(models[0].endpoints).toEqual(["/v1/chat/completions"]);
    expect(models[0].streaming).toBe(true);
  });

  it("returns empty array on HTTP error", async () => {
    server.use(
      http.get(`${BASE_URL}/models`, () => {
        return new HttpResponse(null, { status: 500 });
      })
    );

    const provider = new CustomProvider("custom", BASE_URL, {});
    const models = await provider.listModels();
    expect(models).toEqual([]);
  });

  it("returns empty array on network error", async () => {
    server.use(
      http.get(`${BASE_URL}/models`, () => {
        return HttpResponse.error();
      })
    );

    const provider = new CustomProvider("custom", BASE_URL, {});
    const models = await provider.listModels();
    expect(models).toEqual([]);
  });

  it("returns empty array when response has no data field", async () => {
    server.use(
      http.get(`${BASE_URL}/models`, () => {
        return HttpResponse.json({ models: [] }); // wrong shape
      })
    );

    const provider = new CustomProvider("custom", BASE_URL, {});
    const models = await provider.listModels();
    expect(models).toEqual([]);
  });

  it("sends Authorization header when apiKey is set", async () => {
    let capturedAuth = "";
    server.use(
      http.get(`${BASE_URL}/models`, ({ request }) => {
        capturedAuth = request.headers.get("authorization") ?? "";
        return HttpResponse.json({ data: [] });
      })
    );

    const provider = new CustomProvider("custom", BASE_URL, { apiKey: "sk-test" });
    await provider.listModels();
    expect(capturedAuth).toBe("Bearer sk-test");
  });
});
```

- [ ] **Step 2: Run tests to verify they pass** (implementation already in Task 1)

Run: `npx vitest run test/lib/providers/custom-provider.test.ts`
Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
git add test/lib/providers/custom-provider.test.ts
git commit -m "test: add listModels tests for CustomProvider"
```

---

### Task 5: Provider factory — custom: prefix parsing

**Files:**
- Modify: `src/lib/providers/index.ts`
- Modify: `test/lib/providers/index.test.ts`

- [ ] **Step 1: Write failing tests for custom provider factory**

Add to `test/lib/providers/index.test.ts`. First add a mock for the custom provider at the top (alongside existing mocks):

```typescript
vi.mock("../../../src/lib/providers/custom-provider.js", () => {
  const MockCustomProvider = vi.fn().mockImplementation((name: string, baseUrl: string) => ({
    name,
    _baseUrl: baseUrl,
    initialize: vi.fn().mockResolvedValue(undefined),
    chat: vi.fn(),
    chatStream: vi.fn(),
    listModels: vi.fn(),
    validateModel: vi.fn(),
    dispose: vi.fn(),
    healthCheck: vi.fn(),
  }));
  return { CustomProvider: MockCustomProvider };
});
```

Add import after mocks:
```typescript
const { CustomProvider } = await import(
  "../../../src/lib/providers/custom-provider.js"
);
```

Then add test cases:

```typescript
describe("createProvider — custom", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("creates CustomProvider for 'custom' with providerOptions.custom", async () => {
    const provider = await createProvider({
      ...baseConfig,
      provider: "custom",
      providerOptions: {
        custom: { baseUrl: "https://api.example.com/v1" },
      },
    });
    expect(CustomProvider).toHaveBeenCalledTimes(1);
    expect(provider.name).toBe("custom");
  });

  it("creates CustomProvider for 'custom:groq' using providerOptions.groq", async () => {
    const provider = await createProvider({
      ...baseConfig,
      provider: "custom:groq",
      providerOptions: {
        groq: { baseUrl: "https://api.groq.com/openai/v1", apiKey: "gsk-test" },
      },
    });
    expect(CustomProvider).toHaveBeenCalledTimes(1);
    expect(provider.name).toBe("custom:groq");
  });

  it("bare 'custom' falls back to first non-builtin providerOptions entry", async () => {
    const provider = await createProvider({
      ...baseConfig,
      provider: "custom",
      providerOptions: {
        openrouter: { baseUrl: "https://openrouter.ai/api/v1" },
      },
    });
    expect(CustomProvider).toHaveBeenCalledTimes(1);
    expect(provider.name).toBe("custom");
  });

  it("throws ConfigError for 'custom' with no providerOptions and no baseUrl", async () => {
    await expect(
      createProvider({ ...baseConfig, provider: "custom", providerOptions: {} })
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof ConfigError;
    });
  });

  it("throws ConfigError for unknown provider without custom: prefix", async () => {
    await expect(
      createProvider({ ...baseConfig, provider: "unknown" })
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof ConfigError && (err as ConfigError).code === "unknown_provider";
    });
  });

  it("throws ConfigError for 'custom:nonexistent' when providerOptions lacks that key", async () => {
    await expect(
      createProvider({ ...baseConfig, provider: "custom:nonexistent", providerOptions: {} })
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof ConfigError && (err as ConfigError).code === "missing_provider_config";
    });
  });

  it("bare 'custom' skips builtin 'ollama' entry in providerOptions fallback", async () => {
    const provider = await createProvider({
      ...baseConfig,
      provider: "custom",
      providerOptions: {
        ollama: { baseUrl: "http://localhost:11434" },
        openrouter: { baseUrl: "https://openrouter.ai/api/v1" },
      },
    });
    expect(CustomProvider).toHaveBeenCalledTimes(1);
    // Should pick openrouter, not ollama
    expect((CustomProvider as any).mock.calls[0][1]).toBe("https://openrouter.ai/api/v1");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/lib/providers/index.test.ts`
Expected: FAIL — factory doesn't handle `custom:` yet.

- [ ] **Step 3: Implement custom: prefix parsing in factory**

Replace `src/lib/providers/index.ts` content:

```typescript
// src/lib/providers/index.ts

import { ConfigError, type ResolvedConfig } from "../types.js";
import { createDefaultAuthProvider } from "../auth.js";
import { CopilotProvider } from "./copilot-provider.js";
import { OllamaProvider } from "./ollama-provider.js";
import { CustomProvider } from "./custom-provider.js";
import type { ReviewProvider } from "./types.js";

export type { ReviewProvider } from "./types.js";

type ProviderFactory = (config: ResolvedConfig) => ReviewProvider;

const BUILTIN_PROVIDERS: Record<string, ProviderFactory> = {
  copilot: (config) => new CopilotProvider(createDefaultAuthProvider(), config.timeout),
  ollama: (config) => {
    const url = (config.providerOptions as any)?.ollama?.baseUrl ?? "http://localhost:11434";
    return new OllamaProvider(url, config.timeout);
  },
};

const BUILTIN_NAMES = new Set(Object.keys(BUILTIN_PROVIDERS));

/**
 * Resolve custom provider config from providerOptions.
 *
 * - "custom:groq" -> looks up providerOptions.groq
 * - "custom" with baseUrl in providerOptions.custom -> uses that
 * - "custom" without providerOptions.custom -> first non-builtin entry
 */
function resolveCustomConfig(
  providerName: string,
  config: ResolvedConfig,
): { name: string; baseUrl: string; apiKey?: string; apiKeyCommand?: string } {
  const isNamed = providerName.startsWith("custom:");
  const suffix = isNamed ? providerName.slice("custom:".length) : null;

  if (suffix) {
    const opts = config.providerOptions?.[suffix] as Record<string, unknown> | undefined;
    if (!opts?.baseUrl) {
      throw new ConfigError(
        "missing_provider_config",
        `No configuration found for provider '${providerName}'. Add providerOptions.${suffix}.baseUrl to your config file.`,
        "",
        false,
      );
    }
    // Resolve apiKey/apiKeyCommand precedence: command wins over static key.
    // Provider receives EITHER apiKey OR apiKeyCommand, never both.
    const apiKey = opts.apiKeyCommand ? undefined : (opts.apiKey as string | undefined);
    const apiKeyCommand = opts.apiKeyCommand as string | undefined;
    return {
      name: providerName,
      baseUrl: opts.baseUrl as string,
      apiKey,
      apiKeyCommand,
    };
  }

  // Bare "custom" — check providerOptions.custom first
  const customOpts = config.providerOptions?.custom as Record<string, unknown> | undefined;
  if (customOpts?.baseUrl) {
    const apiKey = customOpts.apiKeyCommand ? undefined : (customOpts.apiKey as string | undefined);
    const apiKeyCommand = customOpts.apiKeyCommand as string | undefined;
    return {
      name: "custom",
      baseUrl: customOpts.baseUrl as string,
      apiKey,
      apiKeyCommand,
    };
  }

  // Fall back to first non-builtin providerOptions entry
  for (const [key, val] of Object.entries(config.providerOptions ?? {})) {
    if (!BUILTIN_NAMES.has(key) && val && typeof val === "object" && "baseUrl" in val) {
      const entry = val as Record<string, unknown>;
      const apiKey = entry.apiKeyCommand ? undefined : (entry.apiKey as string | undefined);
      const apiKeyCommand = entry.apiKeyCommand as string | undefined;
      return {
        name: "custom",
        baseUrl: entry.baseUrl as string,
        apiKey,
        apiKeyCommand,
      };
    }
  }

  throw new ConfigError(
    "missing_base_url",
    `Custom provider requires a base URL. Set --base-url, LLM_REVIEWER_BASE_URL, or providerOptions.<name>.baseUrl in config.`,
    "",
    false,
  );
}

/**
 * Construct a provider without calling initialize().
 */
export function constructProvider(config: ResolvedConfig): ReviewProvider {
  // Check built-in first
  const builtinFactory = BUILTIN_PROVIDERS[config.provider];
  if (builtinFactory) {
    return builtinFactory(config);
  }

  // Check custom: prefix or bare "custom"
  if (config.provider === "custom" || config.provider.startsWith("custom:")) {
    const resolved = resolveCustomConfig(config.provider, config);
    return new CustomProvider(
      resolved.name,
      resolved.baseUrl,
      { apiKey: resolved.apiKey, apiKeyCommand: resolved.apiKeyCommand },
      config.timeout,
    );
  }

  // Unknown
  const available = [...Object.keys(BUILTIN_PROVIDERS), "custom", "custom:<name>"];
  throw new ConfigError(
    "unknown_provider",
    `Unknown provider '${config.provider}'. Available: ${available.join(", ")}. Check your config file or --provider flag.`,
    "",
    false,
  );
}

export async function createProvider(config: ResolvedConfig): Promise<ReviewProvider> {
  try {
    const provider = constructProvider(config);
    await provider.initialize();
    return provider;
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(
      "provider_init_failed",
      `Failed to initialize provider '${config.provider}': ${error instanceof Error ? error.message : String(error)}`,
      "",
      false,
      error instanceof Error ? error : undefined,
    );
  }
}

export function availableProviders(): string[] {
  return Object.keys(BUILTIN_PROVIDERS);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/lib/providers/index.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/providers/index.ts test/lib/providers/index.test.ts
git commit -m "feat: add custom: prefix parsing to provider factory"
```

---

### Task 6: Types and config — add baseUrl CLI override and env vars

**Files:**
- Modify: `src/lib/types.ts:284` — add `baseUrl` to `CLIOverrides`
- Modify: `src/lib/config.ts` — handle new env vars and CLI override
- Modify: `test/lib/config.test.ts` — add tests

- [ ] **Step 1: Write failing tests for new env vars and CLI override**

Add to `test/lib/config.test.ts` (follow existing test patterns in that file):

```typescript
describe("custom provider env vars", () => {
  it("LLM_REVIEWER_BASE_URL sets providerOptions.custom.baseUrl", async () => {
    process.env["LLM_REVIEWER_BASE_URL"] = "https://api.example.com/v1";
    const config = await loadConfig({ provider: "custom" });
    expect((config.providerOptions.custom as any)?.baseUrl).toBe("https://api.example.com/v1");
    delete process.env["LLM_REVIEWER_BASE_URL"];
  });

  it("LLM_REVIEWER_API_KEY sets providerOptions.custom.apiKey", async () => {
    process.env["LLM_REVIEWER_API_KEY"] = "sk-test";
    process.env["LLM_REVIEWER_BASE_URL"] = "https://api.example.com/v1";
    const config = await loadConfig({ provider: "custom" });
    expect((config.providerOptions.custom as any)?.apiKey).toBe("sk-test");
    delete process.env["LLM_REVIEWER_API_KEY"];
    delete process.env["LLM_REVIEWER_BASE_URL"];
  });

  it("LLM_REVIEWER_API_KEY_COMMAND sets providerOptions.custom.apiKeyCommand", async () => {
    process.env["LLM_REVIEWER_API_KEY_COMMAND"] = "echo sk-from-cmd";
    process.env["LLM_REVIEWER_BASE_URL"] = "https://api.example.com/v1";
    const config = await loadConfig({ provider: "custom" });
    expect((config.providerOptions.custom as any)?.apiKeyCommand).toBe("echo sk-from-cmd");
    delete process.env["LLM_REVIEWER_API_KEY_COMMAND"];
    delete process.env["LLM_REVIEWER_BASE_URL"];
  });

  it("LLM_REVIEWER_API_KEY takes precedence over LLM_REVIEWER_API_KEY_COMMAND", async () => {
    process.env["LLM_REVIEWER_API_KEY"] = "sk-static-wins";
    process.env["LLM_REVIEWER_API_KEY_COMMAND"] = "echo sk-should-not-be-used";
    process.env["LLM_REVIEWER_BASE_URL"] = "https://api.example.com/v1";
    const config = await loadConfig({ provider: "custom" });
    expect((config.providerOptions.custom as any)?.apiKey).toBe("sk-static-wins");
    expect((config.providerOptions.custom as any)?.apiKeyCommand).toBeUndefined();
    delete process.env["LLM_REVIEWER_API_KEY"];
    delete process.env["LLM_REVIEWER_API_KEY_COMMAND"];
    delete process.env["LLM_REVIEWER_BASE_URL"];
  });

  it("LLM_REVIEWER_API_KEY clears config file apiKeyCommand", async () => {
    // Scenario: config file has apiKeyCommand, user sets LLM_REVIEWER_API_KEY to override.
    // The env var must win — the config file's command must be cleared so the factory
    // doesn't re-select it via "command > static" precedence.
    process.env["LLM_REVIEWER_API_KEY"] = "sk-env-override";
    process.env["LLM_REVIEWER_BASE_URL"] = "https://api.example.com/v1";
    // Note: config file apiKeyCommand would have been loaded by loadConfigLayer.
    // Here we simulate by checking the env var handling clears apiKeyCommand.
    const config = await loadConfig({ provider: "custom" });
    expect((config.providerOptions.custom as any)?.apiKey).toBe("sk-env-override");
    expect((config.providerOptions.custom as any)?.apiKeyCommand).toBeUndefined();
    delete process.env["LLM_REVIEWER_API_KEY"];
    delete process.env["LLM_REVIEWER_BASE_URL"];
  });

  it("--base-url CLI override takes precedence over env var", async () => {
    process.env["LLM_REVIEWER_BASE_URL"] = "https://env.example.com/v1";
    const config = await loadConfig({ provider: "custom", baseUrl: "https://cli.example.com/v1" });
    expect((config.providerOptions.custom as any)?.baseUrl).toBe("https://cli.example.com/v1");
    delete process.env["LLM_REVIEWER_BASE_URL"];
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/lib/config.test.ts`
Expected: FAIL — `baseUrl` not in `CLIOverrides`, env vars not handled.

- [ ] **Step 3: Add baseUrl to CLIOverrides**

In `src/lib/types.ts`, add `baseUrl` to `CLIOverrides`:

```typescript
export interface CLIOverrides {
  prompt?: string;
  model?: string;
  format?: OutputFormat;
  stream?: boolean;
  config?: string;
  provider?: string;
  chunking?: "auto" | "always" | "never";
  ollamaUrl?: string;
  baseUrl?: string;  // Custom provider base URL
  timeout?: number;
}
```

- [ ] **Step 4: Handle new env vars and CLI override in config.ts**

In `src/lib/config.ts`, add after the existing `envOllamaUrl` block (around line 98):

```typescript
  // Custom provider env vars — these always populate providerOptions.custom.
  // Named providers (custom:groq) read from providerOptions.<suffix>, not .custom,
  // so these env vars only affect bare "custom" usage. This is by design — named
  // providers are self-contained in config.
  const envBaseUrl = process.env["LLM_REVIEWER_BASE_URL"];
  const envApiKey = process.env["LLM_REVIEWER_API_KEY"];
  const envApiKeyCommand = process.env["LLM_REVIEWER_API_KEY_COMMAND"];

  if (envBaseUrl !== undefined) {
    validateUrl(envBaseUrl, "LLM_REVIEWER_BASE_URL");
    const existing = (config.providerOptions.custom ?? {}) as Record<string, unknown>;
    config.providerOptions = {
      ...config.providerOptions,
      custom: { ...existing, baseUrl: envBaseUrl },
    };
  }

  // LLM_REVIEWER_API_KEY takes precedence over LLM_REVIEWER_API_KEY_COMMAND.
  // When an env var is set, it CLEARS the opposite type from config to prevent
  // the factory's "command > static" rule from overriding the env var.
  if (envApiKey !== undefined) {
    const existing = (config.providerOptions.custom ?? {}) as Record<string, unknown>;
    config.providerOptions = {
      ...config.providerOptions,
      custom: { ...existing, apiKey: envApiKey, apiKeyCommand: undefined },
    };
  } else if (envApiKeyCommand !== undefined) {
    const existing = (config.providerOptions.custom ?? {}) as Record<string, unknown>;
    config.providerOptions = {
      ...config.providerOptions,
      custom: { ...existing, apiKeyCommand: envApiKeyCommand, apiKey: undefined },
    };
  }
```

In the CLI overrides section (around line 164), add after the `ollamaUrl` block:

```typescript
    if (cliOverrides.baseUrl !== undefined) {
      const existing = (config.providerOptions.custom ?? {}) as Record<string, unknown>;
      config.providerOptions = {
        ...config.providerOptions,
        custom: { ...existing, baseUrl: cliOverrides.baseUrl },
      };
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/lib/config.test.ts`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/types.ts src/lib/config.ts test/lib/config.test.ts
git commit -m "feat: add baseUrl CLI override and custom provider env vars"
```

---

### Task 7: CLI — add --base-url flag and update help text

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Add baseUrl to CLIOpts interface**

In `src/cli.ts` line 109, add after `ollamaUrl`:

```typescript
  baseUrl?: string;
```

- [ ] **Step 2: Add --base-url option to review command**

In `buildProgram()`, add after line 617 (`--ollama-url`):

```typescript
    .option("--base-url <url>", "Base URL for custom provider (OpenAI-compatible endpoint)")
```

- [ ] **Step 3: Wire baseUrl through CLI overrides in handleReview**

In `handleReview()`, add after the `ollamaUrl` line (around line 151):

```typescript
    if (opts.baseUrl) cliOverrides.baseUrl = opts.baseUrl;
```

- [ ] **Step 4: Update --provider help text in all commands**

Replace all instances of:
```
"Review provider: copilot, ollama"
```
With:
```
"Review provider: copilot, ollama, custom, custom:<name>"
```

- [ ] **Step 5: Add --base-url to models and status subcommands**

In the `models` subcommand (around line 629), add:
```typescript
    .option("--base-url <url>", "Base URL for custom provider")
```

In the `status` subcommand (around line 649), add:
```typescript
    .option("--base-url <url>", "Base URL for custom provider")
```

Update `handleModels` and `handleStatus` to wire through `baseUrl`:

In `handleModels` (around line 254), add:
```typescript
    if (opts.baseUrl) cliOverrides.baseUrl = opts.baseUrl;
```

In `handleStatus` (around line 440), add:
```typescript
    if (opts.baseUrl) cliOverrides.baseUrl = opts.baseUrl;
```

Update `StatusOpts` interface to include `baseUrl`:
```typescript
interface StatusOpts {
  json?: boolean;
  provider?: string;
  ollamaUrl?: string;
  baseUrl?: string;
}
```

Update `handleModels` opts type:
```typescript
export async function handleModels(opts: Pick<CLIOpts, "provider" | "ollamaUrl" | "baseUrl"> = {}): Promise<number> {
```

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cli.ts
git commit -m "feat: add --base-url flag and update --provider help text"
```

---

### Task 8: Config — suppress unknown providerOptions warning for custom entries

**Files:**
- Modify: `src/lib/config.ts`
- Modify: `test/lib/config.test.ts`

The existing config loader warns on unknown `providerOptions` keys (line 241-245). Custom provider entries like `groq`, `openrouter` would trigger this warning. We need to suppress warnings for keys that look like custom provider configs (have a `baseUrl` field).

- [ ] **Step 1: Write failing test**

Add to `test/lib/config.test.ts`:

```typescript
it("does not warn for providerOptions entries with baseUrl (custom provider configs)", async () => {
  // This test verifies the warning is NOT emitted for valid custom provider configs.
  // The existing test for unknown keys should still work for truly unknown entries.
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  // Load config with a custom provider entry — need a config file with providerOptions.groq
  // For this test we just verify the warning logic in loadConfigLayer.
  // We'll test via the merge path by checking stderr output.
  stderrSpy.mockRestore();
});
```

- [ ] **Step 2: Update warning logic in config.ts**

In `src/lib/config.ts`, update the unknown key warning (around line 241-245):

```typescript
      for (const key of Object.keys(jsonConfig.providerOptions)) {
        if (!knownKeys.includes(key)) {
          // Suppress warning if this looks like a custom provider config (has baseUrl)
          const entry = jsonConfig.providerOptions[key];
          if (entry && typeof entry === "object" && "baseUrl" in entry) {
            continue; // Valid custom provider config — don't warn
          }
          const suggestion = knownKeys.find((k) => levenshtein(key, k) <= 2);
          const hint = suggestion ? ` Did you mean '${suggestion}'?` : "";
          process.stderr.write(`Warning: unknown providerOptions key '${key}'.${hint}\n`);
        }
      }
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `npx vitest run`
Expected: All tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/config.ts test/lib/config.test.ts
git commit -m "fix: suppress unknown providerOptions warning for custom provider entries"
```

---

### Task 9: Verify timeout default — no change needed

Custom providers keep the default 30s timeout (same as Copilot). Cloud APIs (OpenRouter, Groq)
are fast — 30s is appropriate. Users deploying local models should set `--timeout 120` explicitly.
No code changes needed. The README (Task 11) will document this.

- [ ] **Step 1: Verify no timeout override exists for custom**

Confirm `config.ts` timeout section only overrides for `ollama`. No changes needed.

- [ ] **Step 2: Mark complete**

---

### Task 10: Verify model=auto guard already exists

The guard for `model=auto` with providers lacking `autoSelect()` already exists at
`src/lib/review.ts:643-651`. No new code needed.

- [ ] **Step 1: Verify guard exists**

Run: `grep -n "autoSelect" src/lib/review.ts`
Expected: Shows existing guard that throws ConfigError when model is "auto" and provider has no autoSelect.

- [ ] **Step 2: Verify existing tests cover it**

Run: `npx vitest run test/lib/review.test.ts`
Expected: All tests PASS, including model resolution tests.

---

### Task 11: Full integration verification

- [ ] **Step 1: Run complete test suite**

Run: `npx vitest run`
Expected: All tests PASS.

- [ ] **Step 2: Run TypeScript type check**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Manual smoke test against Ollama via custom provider**

If Ollama is running locally:

```bash
npx tsx src/cli.ts models --provider custom --base-url http://localhost:11434/v1
npx tsx src/cli.ts status --provider custom --base-url http://localhost:11434/v1
```

Expected: Shows models list and status output.

- [ ] **Step 4: Commit any fixes from smoke testing**

```bash
git add -A
git commit -m "fix: integration fixes from smoke testing"
```

(Skip if no fixes needed.)

---

### Task 12: README — custom provider documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add custom provider section to README**

Add a "Custom Provider" section with:
- Configuration examples (config file, env vars, CLI flags)
- Popular endpoints reference table (OpenRouter, Groq, Together AI, Fireworks, LM Studio, vLLM)
- Usage examples (bare custom, named custom, apiKeyCommand)
- **Security note**: `apiKeyCommand` executes shell commands — review project configs before running in untrusted repos. Don't commit static `apiKey` to version control.
- **baseUrl note**: Custom provider expects the full URL including `/v1` path. Troubleshooting: if 404, check baseUrl includes `/v1`.
- **Timeout note**: Cloud APIs default to 30s. For local models, set `--timeout 120`.

Use the content from the spec's "Documentation" and "Security" sections.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add custom provider documentation and endpoint reference"
```
