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

    it("throws ConfigError when baseUrl is whitespace", () => {
      expect(() => new CustomProvider("custom", "   ", {})).toThrow(ConfigError);
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

  describe("getHeaders() with apiKeyCommand", () => {
    it("executes command and uses stdout as Bearer token", async () => {
      const provider = new CustomProvider("custom", BASE_URL, {
        apiKeyCommand: "echo sk-from-command",
      });
      const headers = await (provider as any).getHeaders();
      expect(headers).toEqual({ Authorization: "Bearer sk-from-command" });
    });

    it("caches command result — second call does not re-execute", async () => {
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
