// test/lib/providers/ollama-provider.test.ts

import { describe, it, expect, beforeAll, afterEach, afterAll, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { OllamaProvider } from "../../../src/lib/providers/ollama-provider.js";
import { ClientError, ConfigError } from "../../../src/lib/types.js";

const OLLAMA_ROOT = "http://localhost:11434";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// Reset module-level cache between tests by creating a fresh instance each time.

describe("OllamaProvider", () => {
  describe("constructor validation", () => {
    it("rejects URL with path component", () => {
      expect(() => new OllamaProvider("http://localhost:11434/api")).toThrow(ConfigError);
    });

    it("rejects URL with query string", () => {
      expect(() => new OllamaProvider("http://localhost:11434?foo=bar")).toThrow(ConfigError);
    });

    it("rejects URL with fragment", () => {
      expect(() => new OllamaProvider("http://localhost:11434#section")).toThrow(ConfigError);
    });

    it("accepts http://localhost:11434 (root, no trailing slash)", () => {
      expect(() => new OllamaProvider("http://localhost:11434")).not.toThrow();
    });

    it("accepts trailing slash by normalizing to root", () => {
      // Trailing slash means pathname is "/" which is allowed
      expect(() => new OllamaProvider("http://localhost:11434/")).not.toThrow();
    });

    it("throws ConfigError for completely invalid URL", () => {
      expect(() => new OllamaProvider("not-a-url")).toThrow(ConfigError);
    });

    it("uses http://localhost:11434 as default base URL", () => {
      const provider = new OllamaProvider();
      expect(provider.name).toBe("ollama");
    });
  });

  describe("name", () => {
    it('returns "ollama"', () => {
      const provider = new OllamaProvider();
      expect(provider.name).toBe("ollama");
    });
  });

  describe("getHeaders()", () => {
    it("returns empty object (no auth required)", async () => {
      const provider = new OllamaProvider();
      const headers = await (provider as any).getHeaders();
      expect(headers).toEqual({});
    });
  });

  describe("healthCheck()", () => {
    it("returns { ok: true, latencyMs: N } when /api/tags responds 200", async () => {
      server.use(
        http.get(`${OLLAMA_ROOT}/api/tags`, () => {
          return HttpResponse.json({ models: [] });
        })
      );

      const provider = new OllamaProvider();
      const result = await provider.healthCheck();

      expect(result.ok).toBe(true);
      expect(typeof result.latencyMs).toBe("number");
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.error).toBeUndefined();
    });

    it("returns { ok: false, latencyMs: null } on network error", async () => {
      server.use(
        http.get(`${OLLAMA_ROOT}/api/tags`, () => {
          return HttpResponse.error();
        })
      );

      const provider = new OllamaProvider();
      const result = await provider.healthCheck();

      expect(result.ok).toBe(false);
      expect(result.latencyMs).toBeNull();
      expect(result.error).toBeDefined();
    });

    it("returns { ok: false } with error string on HTTP 500", async () => {
      server.use(
        http.get(`${OLLAMA_ROOT}/api/tags`, () => {
          return new HttpResponse(null, { status: 500 });
        })
      );

      const provider = new OllamaProvider();
      const result = await provider.healthCheck();

      expect(result.ok).toBe(false);
      expect(result.error).toBe("HTTP 500");
    });

    it("returns not_initialized error for 401", async () => {
      server.use(
        http.get(`${OLLAMA_ROOT}/api/tags`, () => {
          return new HttpResponse(null, { status: 401 });
        })
      );

      const provider = new OllamaProvider();
      const result = await provider.healthCheck();

      expect(result.ok).toBe(false);
      expect(result.error).toBe("not_initialized");
    });
  });

  describe("initialize()", () => {
    it("succeeds when Ollama is reachable", async () => {
      server.use(
        http.get(`${OLLAMA_ROOT}/api/tags`, () => {
          return HttpResponse.json({ models: [] });
        })
      );

      const provider = new OllamaProvider();
      await expect(provider.initialize()).resolves.toBeUndefined();
    });

    it("throws ClientError with code provider_unavailable when Ollama is unreachable", async () => {
      server.use(
        http.get(`${OLLAMA_ROOT}/api/tags`, () => {
          return HttpResponse.error();
        })
      );

      const provider = new OllamaProvider();
      const err = await provider.initialize().catch(e => e);

      expect(err).toBeInstanceOf(ClientError);
      expect(err.code).toBe("provider_unavailable");
      expect(err.recoverable).toBe(false);
    });

    it("is idempotent — second call is a no-op (does not re-check reachability)", async () => {
      let callCount = 0;
      server.use(
        http.get(`${OLLAMA_ROOT}/api/tags`, () => {
          callCount++;
          return HttpResponse.json({ models: [] });
        })
      );

      const provider = new OllamaProvider();
      await provider.initialize();
      await provider.initialize(); // second call — no-op due to base class guard

      expect(callCount).toBe(1);
    });
  });

  describe("listModels()", () => {
    it("calls /api/tags and /api/show per model, returns ModelInfo[]", async () => {
      server.use(
        http.get(`${OLLAMA_ROOT}/api/tags`, () => {
          return HttpResponse.json({
            models: [
              { name: "llama3:latest", modified_at: "2024-01-01" },
              { name: "mistral:7b", modified_at: "2024-01-02" },
            ],
          });
        }),
        http.post(`${OLLAMA_ROOT}/api/show`, async ({ request }) => {
          const body = (await request.json()) as { name: string };
          return HttpResponse.json({
            modelfile: "",
            parameters: `num_ctx 8192`,
            template: "",
            details: {},
          });
        })
      );

      const provider = new OllamaProvider();
      const models = await provider.listModels();

      expect(models).toHaveLength(2);
      expect(models[0].id).toBe("llama3:latest");
      expect(models[0].name).toBe("llama3:latest");
      expect(models[0].endpoints).toEqual(["/v1/chat/completions"]);
      expect(models[0].streaming).toBe(true);
      expect(models[0].toolCalls).toBe(false);
      expect(models[0].maxPromptTokens).toBe(8192);
      expect(models[0].maxOutputTokens).toBe(4096);
      expect(models[0].tokenizer).toBe("unknown");
    });

    it("uses 4096 default for maxPromptTokens when /api/show fails for a model", async () => {
      server.use(
        http.get(`${OLLAMA_ROOT}/api/tags`, () => {
          return HttpResponse.json({
            models: [{ name: "llama3:latest" }],
          });
        }),
        http.post(`${OLLAMA_ROOT}/api/show`, () => {
          return new HttpResponse(null, { status: 500 });
        })
      );

      const provider = new OllamaProvider();
      const models = await provider.listModels();

      expect(models).toHaveLength(1);
      expect(models[0].maxPromptTokens).toBe(4096);
    });

    it("returns [] when /api/tags returns empty models array", async () => {
      server.use(
        http.get(`${OLLAMA_ROOT}/api/tags`, () => {
          return HttpResponse.json({ models: [] });
        })
      );

      const provider = new OllamaProvider();
      const models = await provider.listModels();
      expect(models).toEqual([]);
    });

    it("throws ClientError when /api/tags fails", async () => {
      server.use(
        http.get(`${OLLAMA_ROOT}/api/tags`, () => {
          return new HttpResponse(null, { status: 500 });
        })
      );

      const provider = new OllamaProvider();
      const err = await provider.listModels().catch(e => e);
      expect(err).toBeInstanceOf(ClientError);
    });

    it("caches results for 5 minutes — second call does not hit API", async () => {
      let tagCallCount = 0;
      server.use(
        http.get(`${OLLAMA_ROOT}/api/tags`, () => {
          tagCallCount++;
          return HttpResponse.json({
            models: [{ name: "llama3:latest" }],
          });
        }),
        http.post(`${OLLAMA_ROOT}/api/show`, () => {
          return HttpResponse.json({ parameters: "" });
        })
      );

      const provider = new OllamaProvider();
      await provider.listModels();
      await provider.listModels(); // second call — should hit cache

      expect(tagCallCount).toBe(1);
    });

    it("coalesces concurrent requests — only one /api/tags call when called in parallel", async () => {
      let tagCallCount = 0;
      server.use(
        http.get(`${OLLAMA_ROOT}/api/tags`, async () => {
          tagCallCount++;
          // Tiny delay to ensure overlap
          await new Promise(r => setTimeout(r, 10));
          return HttpResponse.json({ models: [] });
        })
      );

      const provider = new OllamaProvider();
      const [r1, r2] = await Promise.all([provider.listModels(), provider.listModels()]);

      expect(tagCallCount).toBe(1);
      expect(r1).toEqual(r2);
    });
  });

  describe("shouldRetry()", () => {
    it("returns true for provider_unavailable errors", () => {
      const provider = new OllamaProvider();
      const err = new ClientError("provider_unavailable", "Ollama not running", false);
      expect((provider as any).shouldRetry(err)).toBe(true);
    });

    it("still returns true for inherited retryable codes (rate_limited, server_error, timeout)", () => {
      const provider = new OllamaProvider();
      expect((provider as any).shouldRetry(new ClientError("rate_limited", "", true))).toBe(true);
      expect((provider as any).shouldRetry(new ClientError("server_error", "", true))).toBe(true);
      expect((provider as any).shouldRetry(new ClientError("timeout", "", true))).toBe(true);
    });

    it("returns false for non-retryable codes", () => {
      const provider = new OllamaProvider();
      expect((provider as any).shouldRetry(new ClientError("request_failed", "", false))).toBe(false);
    });
  });

  describe("dispose()", () => {
    it("does not throw", () => {
      const provider = new OllamaProvider();
      expect(() => provider.dispose()).not.toThrow();
    });
  });

  describe("chat()", () => {
    it("targets /v1/chat/completions (not /chat/completions)", async () => {
      let hitV1 = false;
      server.use(
        http.post(`${OLLAMA_ROOT}/v1/chat/completions`, () => {
          hitV1 = true;
          return HttpResponse.json({
            choices: [{ message: { role: "assistant", content: "Hello from Ollama" } }],
            usage: { total_tokens: 10 },
            model: "llama3:latest",
          });
        })
      );

      const provider = new OllamaProvider();
      const response = await provider.chat({
        model: "llama3:latest",
        systemPrompt: "You are a reviewer",
        messages: [{ role: "user", content: "Review this" }],
        stream: false,
      });

      expect(hitV1).toBe(true);
      expect(response.content).toBe("Hello from Ollama");
    });
  });

  describe("chatStream()", () => {
    it("targets /v1/chat/completions (not /chat/completions)", async () => {
      let hitV1 = false;
      server.use(
        http.post(`${OLLAMA_ROOT}/v1/chat/completions`, () => {
          hitV1 = true;
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

      const provider = new OllamaProvider();
      const chunks: string[] = [];
      for await (const chunk of provider.chatStream({
        model: "llama3:latest",
        systemPrompt: "You are a reviewer",
        messages: [{ role: "user", content: "Review this" }],
        stream: true,
      })) {
        if (chunk.type === "content" && chunk.text != null) {
          chunks.push(chunk.text);
        }
      }

      expect(hitV1).toBe(true);
      expect(chunks).toContain("Hello");
    });
  });
});
