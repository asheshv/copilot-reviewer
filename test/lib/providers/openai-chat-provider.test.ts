// test/lib/providers/openai-chat-provider.test.ts

import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { OpenAIChatProvider } from "../../../src/lib/providers/openai-chat-provider.js";
import type { ModelInfo, ChatRequest } from "../../../src/lib/types.js";
import { ClientError, ModelError } from "../../../src/lib/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const streamingFixture = readFileSync(
  join(__dirname, "../../fixtures/responses/chat-completions-streaming.txt"),
  "utf8"
);

// Concrete test subclass
class TestProvider extends OpenAIChatProvider {
  readonly name = "test";

  constructor(baseUrl = "http://test.api") {
    super(baseUrl);
  }

  async getHeaders(): Promise<Record<string, string>> {
    return { Authorization: "Bearer test-token" };
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      {
        id: "test-model-1",
        name: "Test Model 1",
        endpoints: ["chat/completions"],
        streaming: true,
        toolCalls: false,
        maxPromptTokens: 4096,
        maxOutputTokens: 2048,
        tokenizer: "cl100k_base",
      },
      {
        id: "test-model-2",
        name: "Test Model 2",
        endpoints: ["chat/completions"],
        streaming: false,
        toolCalls: false,
        maxPromptTokens: 2048,
        maxOutputTokens: 1024,
        tokenizer: "cl100k_base",
      },
    ];
  }
}

// MSW server
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("OpenAIChatProvider", () => {
  describe("chat()", () => {
    it("sends POST to /chat/completions with correct body", async () => {
      let capturedBody: any;
      let capturedHeaders: Headers;

      server.use(
        http.post("http://test.api/chat/completions", async ({ request }) => {
          capturedBody = await request.json();
          capturedHeaders = request.headers;
          return HttpResponse.json({
            choices: [{ message: { role: "assistant", content: "ok" } }],
            usage: { total_tokens: 10 },
            model: "test-model-1",
          });
        })
      );

      const provider = new TestProvider();
      const request: ChatRequest = {
        model: "test-model-1",
        systemPrompt: "You are a reviewer",
        messages: [{ role: "user", content: "Review this" }],
        stream: false,
      };

      await provider.chat(request);

      expect(capturedBody.model).toBe("test-model-1");
      expect(capturedBody.messages[0]).toEqual({ role: "system", content: "You are a reviewer" });
      expect(capturedBody.messages[1]).toEqual({ role: "user", content: "Review this" });
      expect(capturedHeaders!.get("Authorization")).toBe("Bearer test-token");
      expect(capturedHeaders!.get("Content-Type")).toBe("application/json");
    });

    it("parses Chat Completions response: choices[0].message.content, usage.total_tokens, model", async () => {
      server.use(
        http.post("http://test.api/chat/completions", () => {
          return HttpResponse.json({
            choices: [
              {
                message: { role: "assistant", content: "Review findings here." },
                finish_reason: "stop",
              },
            ],
            usage: { total_tokens: 150 },
            model: "gpt-4.1",
          });
        })
      );

      const provider = new TestProvider();
      const request: ChatRequest = {
        model: "test-model-1",
        systemPrompt: "",
        messages: [{ role: "user", content: "Review this" }],
        stream: false,
      };

      const response = await provider.chat(request);

      expect(response.content).toBe("Review findings here.");
      expect(response.usage.totalTokens).toBe(150);
      expect(response.model).toBe("gpt-4.1");
    });

    it("Content-Type cannot be overridden by subclass getHeaders()", async () => {
      // Create a subclass that tries to override Content-Type
      class OverridingProvider extends OpenAIChatProvider {
        readonly name = "overriding";
        async getHeaders() {
          return { "Content-Type": "text/plain", Authorization: "Bearer x" };
        }
        async listModels(): Promise<ModelInfo[]> { return []; }
      }

      let capturedHeaders: Headers;
      server.use(
        http.post("http://test.api/chat/completions", async ({ request }) => {
          capturedHeaders = request.headers;
          return HttpResponse.json({
            choices: [{ message: { role: "assistant", content: "ok" } }],
            usage: { total_tokens: 5 },
            model: "m",
          });
        })
      );

      const provider = new OverridingProvider("http://test.api");
      await provider.chat({
        model: "m",
        systemPrompt: "",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      });

      expect(capturedHeaders!.get("Content-Type")).toBe("application/json");
    });
  });

  describe("chatStream()", () => {
    it("parses SSE stream using fixture", async () => {
      server.use(
        http.post("http://test.api/chat/completions", () => {
          return new HttpResponse(streamingFixture, {
            headers: { "Content-Type": "text/event-stream" },
          });
        })
      );

      const provider = new TestProvider();
      const request: ChatRequest = {
        model: "test-model-1",
        systemPrompt: "",
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
      };

      const chunks = [];
      for await (const chunk of provider.chatStream(request)) {
        chunks.push(chunk);
      }

      expect(chunks.length).toBeGreaterThanOrEqual(2);
      const contentChunks = chunks.filter(c => c.type === "content");
      expect(contentChunks[0].text).toBe("Hello");
      expect(contentChunks[1].text).toBe(" world");
    });

    it("mid-stream error yields {type:'error'} chunk then stops", async () => {
      // SSE: two valid content chunks, then a chunk with abnormal finish_reason
      // parseChatCompletionChunk maps any non-stop/non-tool_calls finish_reason to {type:"error"}
      const sseWithMidStreamError = [
        'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}',
        "",
        'data: {"choices":[{"delta":{"content":" world"},"finish_reason":null}]}',
        "",
        'data: {"choices":[{"finish_reason":"content_filter"}]}',
        "",
        'data: [DONE]',
        "",
      ].join("\n");

      server.use(
        http.post("http://test.api/chat/completions", () => {
          return new HttpResponse(sseWithMidStreamError, {
            headers: { "Content-Type": "text/event-stream" },
          });
        })
      );

      const provider = new TestProvider();
      const request: ChatRequest = {
        model: "test-model-1",
        systemPrompt: "",
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
      };

      const chunks: any[] = [];
      for await (const chunk of provider.chatStream(request)) {
        chunks.push(chunk);
      }

      // Find the error chunk index
      const errorIdx = chunks.findIndex(c => c.type === "error");
      expect(errorIdx).toBeGreaterThanOrEqual(0);
      // No chunks after the error chunk
      expect(chunks.length).toBe(errorIdx + 1);
    });

    it("pre-stream error throws (does NOT yield)", async () => {
      server.use(
        http.post("http://test.api/chat/completions", () => {
          return new HttpResponse(null, { status: 401 });
        })
      );

      const provider = new TestProvider();
      const request: ChatRequest = {
        model: "test-model-1",
        systemPrompt: "",
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
      };

      const chunks: any[] = [];
      let threw = false;
      try {
        for await (const chunk of provider.chatStream(request)) {
          chunks.push(chunk);
        }
      } catch {
        threw = true;
      }

      expect(threw).toBe(true);
      expect(chunks.length).toBe(0);
    });
  });

  describe("validateModel()", () => {
    it("returns the model when found", async () => {
      // No server needed — listModels() is hardcoded in TestProvider
      const provider = new TestProvider();
      const model = await provider.validateModel("test-model-1");
      expect(model.id).toBe("test-model-1");
      expect(model.name).toBe("Test Model 1");
    });

    it("throws ModelError when model not found", async () => {
      const provider = new TestProvider();
      await expect(provider.validateModel("nonexistent-model")).rejects.toThrow(ModelError);
    });
  });

  describe("retry()", () => {
    it("retries on 429 (rate_limited)", async () => {
      let attemptCount = 0;
      server.use(
        http.post("http://test.api/chat/completions", () => {
          attemptCount++;
          if (attemptCount === 1) {
            return new HttpResponse(null, { status: 429, headers: { "retry-after": "1" } });
          }
          return HttpResponse.json({
            choices: [{ message: { role: "assistant", content: "ok" } }],
            usage: { total_tokens: 10 },
            model: "test-model-1",
          });
        })
      );

      const provider = new TestProvider();
      const response = await provider.chat({
        model: "test-model-1",
        systemPrompt: "",
        messages: [{ role: "user", content: "test" }],
        stream: false,
      });

      expect(attemptCount).toBe(2);
      expect(response.content).toBe("ok");
    });

    it("retries on 503 (server_error)", async () => {
      let attemptCount = 0;
      server.use(
        http.post("http://test.api/chat/completions", () => {
          attemptCount++;
          if (attemptCount === 1) {
            return new HttpResponse(null, { status: 503 });
          }
          return HttpResponse.json({
            choices: [{ message: { role: "assistant", content: "ok" } }],
            usage: { total_tokens: 10 },
            model: "test-model-1",
          });
        })
      );

      const provider = new TestProvider();
      const response = await provider.chat({
        model: "test-model-1",
        systemPrompt: "",
        messages: [{ role: "user", content: "test" }],
        stream: false,
      });

      expect(attemptCount).toBe(2);
      expect(response.content).toBe("ok");
    });

    it("does NOT retry on 401 (auth error)", async () => {
      let attemptCount = 0;
      server.use(
        http.post("http://test.api/chat/completions", () => {
          attemptCount++;
          return HttpResponse.json(
            { error: { message: "Unauthorized" } },
            { status: 401 }
          );
        })
      );

      const provider = new TestProvider();
      await expect(
        provider.chat({
          model: "test-model-1",
          systemPrompt: "",
          messages: [{ role: "user", content: "test" }],
          stream: false,
        })
      ).rejects.toThrow();

      expect(attemptCount).toBe(1);
    });

    it("retries on timeout (AbortError)", async () => {
      let attemptCount = 0;

      // Spy on global fetch: first call throws AbortError, second succeeds
      const originalFetch = globalThis.fetch;
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
        attemptCount++;
        if (attemptCount === 1) {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          throw err;
        }
        return originalFetch(...args);
      });

      // Register a handler for the second (real) attempt
      server.use(
        http.post("http://test.api/chat/completions", () => {
          return HttpResponse.json({
            choices: [{ message: { role: "assistant", content: "retried ok" } }],
            usage: { total_tokens: 10 },
            model: "test-model-1",
          });
        })
      );

      try {
        const provider = new TestProvider();
        const response = await provider.chat({
          model: "test-model-1",
          systemPrompt: "",
          messages: [{ role: "user", content: "test" }],
          stream: false,
        });

        expect(attemptCount).toBe(2);
        expect(response.content).toBe("retried ok");
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("does NOT retry on 400 (client error)", async () => {
      let attemptCount = 0;
      server.use(
        http.post("http://test.api/chat/completions", () => {
          attemptCount++;
          return HttpResponse.json(
            { error: { message: "Bad request" } },
            { status: 400 }
          );
        })
      );

      const provider = new TestProvider();
      await expect(
        provider.chat({
          model: "test-model-1",
          systemPrompt: "",
          messages: [{ role: "user", content: "test" }],
          stream: false,
        })
      ).rejects.toThrow(ClientError);

      expect(attemptCount).toBe(1);
    });
  });

  describe("initialize()", () => {
    it("is idempotent — calling twice is safe", async () => {
      const provider = new TestProvider();
      await provider.initialize();
      await provider.initialize(); // second call — must not throw
      // No assertion needed beyond "didn't throw"
      expect(true).toBe(true);
    });
  });

  describe("dispose()", () => {
    it("does not throw", () => {
      const provider = new TestProvider();
      expect(() => provider.dispose()).not.toThrow();
    });
  });

  describe("healthCheck()", () => {
    it("returns { ok: true, latencyMs: N } when server responds", async () => {
      server.use(
        http.get("http://test.api/", () => {
          return new HttpResponse(null, { status: 200 });
        })
      );

      const provider = new TestProvider();
      const result = await provider.healthCheck();

      expect(result.ok).toBe(true);
      expect(typeof result.latencyMs).toBe("number");
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.error).toBeUndefined();
    });

    it("returns { ok: false } when server is unreachable", async () => {
      // Use a URL that won't match any MSW handler to simulate error
      class UnreachableProvider extends OpenAIChatProvider {
        readonly name = "unreachable";
        async getHeaders() { return {}; }
        async listModels(): Promise<ModelInfo[]> { return []; }
      }

      // No server handler — onUnhandledRequest: "error" in MSW will cause a network error
      // We use a different base URL that won't be handled
      server.use(
        http.get("http://unreachable.invalid/", () => {
          return HttpResponse.error();
        })
      );

      const provider = new UnreachableProvider("http://unreachable.invalid");
      const result = await provider.healthCheck();

      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("o1 model quirks", () => {
    it("demotes system prompt to user role for o1 models", async () => {
      let capturedBody: any;
      server.use(
        http.post("http://test.api/chat/completions", async ({ request }) => {
          capturedBody = await request.json();
          return HttpResponse.json({
            choices: [{ message: { role: "assistant", content: "ok" } }],
            usage: { total_tokens: 5 },
            model: "o1-preview",
          });
        })
      );

      const provider = new TestProvider();
      await provider.chat({
        model: "o1-preview",
        systemPrompt: "Be a reviewer",
        messages: [{ role: "user", content: "Review this" }],
        stream: false,
      });

      expect(capturedBody.messages[0].role).toBe("user");
      expect(capturedBody.messages[0].content).toBe("Be a reviewer");
    });

    it("omits temperature/n/top_p for o1 models", async () => {
      let capturedBody: any;
      server.use(
        http.post("http://test.api/chat/completions", async ({ request }) => {
          capturedBody = await request.json();
          return HttpResponse.json({
            choices: [{ message: { role: "assistant", content: "ok" } }],
            usage: { total_tokens: 5 },
            model: "o1-mini",
          });
        })
      );

      const provider = new TestProvider();
      await provider.chat({
        model: "o1-mini",
        systemPrompt: "",
        messages: [{ role: "user", content: "Review" }],
        stream: false,
      });

      expect(capturedBody.temperature).toBeUndefined();
      expect(capturedBody.n).toBeUndefined();
      expect(capturedBody.top_p).toBeUndefined();
    });
  });
});
