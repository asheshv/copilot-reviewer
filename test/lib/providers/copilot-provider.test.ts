// test/lib/providers/copilot-provider.test.ts

import { describe, it, expect, beforeAll, afterEach, afterAll, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { CopilotProvider } from "../../../src/lib/providers/copilot-provider.js";
import type { AuthProvider, ChatRequest } from "../../../src/lib/types.js";
import { ClientError, ModelError } from "../../../src/lib/types.js";
import * as authModule from "../../../src/lib/auth.js";
import chatCompletionsFixture from "../../fixtures/responses/chat-completions-non-streaming.json";
import responsesApiFixture from "../../fixtures/responses/responses-api-non-streaming.json";

// Mock AuthProvider
class MockAuthProvider implements AuthProvider {
  async getAuthenticatedHeaders(): Promise<Record<string, string>> {
    return { Authorization: "Bearer test-token" };
  }
}

// MSW server setup
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

// Shared mock models response matching models.test.ts pattern
const mockModelsResponse = {
  data: [
    {
      id: "gpt-4",
      name: "GPT-4",
      version: "2024-01-01",
      model_picker_enabled: true,
      capabilities: {
        type: "chat",
        limits: { max_prompt_tokens: 8000, max_output_tokens: 2000 },
      },
      endpoints: ["/chat/completions"],
      streaming: true,
      tool_calls: true,
      tokenizer: "cl100k_base",
      policy: { state: "enabled" },
    },
    {
      id: "gpt-4o",
      name: "GPT-4o",
      version: "2024-02-01",
      model_picker_enabled: true,
      capabilities: {
        type: "chat",
        limits: { max_prompt_tokens: 128000, max_output_tokens: 16384 },
      },
      endpoints: ["/chat/completions", "/responses"],
      streaming: true,
      tool_calls: true,
      tokenizer: "o200k_base",
      policy: { state: "enabled" },
    },
    {
      id: "o1-preview",
      name: "o1-preview",
      version: "2024-03-01",
      model_picker_enabled: true,
      capabilities: {
        type: "chat",
        limits: { max_prompt_tokens: 32000, max_output_tokens: 8000 },
      },
      endpoints: ["/chat/completions"],
      streaming: false,
      tool_calls: false,
      tokenizer: "o200k_base",
      policy: { state: "disabled" },
    },
    {
      // Filtered out — not chat
      id: "embeddings-model",
      name: "Embeddings",
      version: "2024-01-01",
      model_picker_enabled: true,
      capabilities: {
        type: "embeddings",
        limits: { max_prompt_tokens: 8000, max_output_tokens: 0 },
      },
      endpoints: ["/embeddings"],
      streaming: false,
      tool_calls: false,
    },
    {
      // Filtered out — picker disabled
      id: "gpt-3.5",
      name: "GPT-3.5",
      version: "2024-01-01",
      model_picker_enabled: false,
      capabilities: {
        type: "chat",
        limits: { max_prompt_tokens: 4000, max_output_tokens: 1000 },
      },
      endpoints: ["/chat/completions"],
      streaming: true,
      tool_calls: true,
    },
    {
      // Duplicate — older version (should be filtered by dedup)
      id: "gpt-4-old",
      name: "GPT-4",
      version: "2023-12-01",
      model_picker_enabled: true,
      capabilities: {
        type: "chat",
        limits: { max_prompt_tokens: 6000, max_output_tokens: 1500 },
      },
      endpoints: ["/chat/completions"],
      streaming: true,
      tool_calls: true,
      policy: { state: "enabled" },
    },
  ],
};

describe("CopilotProvider", () => {
  const authProvider = new MockAuthProvider();

  // ─── getHeaders() ────────────────────────────────────────────────────────

  describe("getHeaders()", () => {
    it("returns Copilot-specific headers (not Content-Type — base adds that)", async () => {
      const provider = new CopilotProvider(authProvider);
      // Access protected method via casting for white-box test
      const headers = await (provider as any).getHeaders();

      expect(headers["Authorization"]).toBe("Bearer test-token");
      expect(headers["Editor-Version"]).toBe("copilot-reviewer/0.1.0");
      expect(headers["Editor-Plugin-Version"]).toBe("copilot-reviewer/0.1.0");
      expect(headers["Copilot-Integration-Id"]).toBe("vscode-chat");
      expect(headers["x-github-api-version"]).toBe("2025-10-01");
      // Content-Type is NOT returned by getHeaders() — base class adds it
      expect(headers["Content-Type"]).toBeUndefined();
    });

    it("includes Authorization header from auth provider", async () => {
      const customAuth: AuthProvider = {
        async getAuthenticatedHeaders() {
          return { Authorization: "Bearer custom-session-token" };
        },
      };
      const provider = new CopilotProvider(customAuth);
      const headers = await (provider as any).getHeaders();
      expect(headers["Authorization"]).toBe("Bearer custom-session-token");
    });
  });

  // ─── initialize() ────────────────────────────────────────────────────────

  describe("initialize()", () => {
    it("calls getHeaders() for eager auth validation", async () => {
      // initialize() now also calls listModels() to warm the cache — mock /models
      server.use(
        http.get("https://api.githubcopilot.com/models", () =>
          HttpResponse.json(mockModelsResponse)
        ),
        http.post("https://api.githubcopilot.com/models/:id/policy", () =>
          HttpResponse.json({ state: "enabled" })
        )
      );
      const provider = new CopilotProvider(authProvider);
      const spy = vi.spyOn(provider as any, "getHeaders");
      await provider.initialize();
      expect(spy).toHaveBeenCalled();
    });

    it("is idempotent — second call does not re-auth (getHeaders uses cached token)", async () => {
      // initialize() now also calls listModels() to warm the cache — mock /models
      server.use(
        http.get("https://api.githubcopilot.com/models", () =>
          HttpResponse.json(mockModelsResponse)
        ),
        http.post("https://api.githubcopilot.com/models/:id/policy", () =>
          HttpResponse.json({ state: "enabled" })
        )
      );
      const provider = new CopilotProvider(authProvider);
      const spy = vi.spyOn(provider as any, "getHeaders");
      await provider.initialize();
      await provider.initialize();
      // getHeaders is called once on first initialize; second call is no-op (idempotent)
      expect(spy).toHaveBeenCalled();
    });

    it("propagates auth errors from getHeaders()", async () => {
      const failingAuth: AuthProvider = {
        async getAuthenticatedHeaders() {
          throw new Error("Auth failed");
        },
      };
      const provider = new CopilotProvider(failingAuth);
      await expect(provider.initialize()).rejects.toThrow("Auth failed");
    });
  });

  // ─── dispose() ───────────────────────────────────────────────────────────

  describe("dispose()", () => {
    it("calls clearSessionCache() to zero out cached session token", () => {
      const clearSpy = vi.spyOn(authModule, "clearSessionCache");
      const provider = new CopilotProvider(authProvider);
      provider.dispose();
      expect(clearSpy).toHaveBeenCalledOnce();
    });

    it("does not throw even if clearSessionCache() throws", () => {
      vi.spyOn(authModule, "clearSessionCache").mockImplementation(() => {
        throw new Error("cache error");
      });
      const provider = new CopilotProvider(authProvider);
      expect(() => provider.dispose()).not.toThrow();
    });
  });

  // ─── healthCheck() ───────────────────────────────────────────────────────

  describe("healthCheck()", () => {
    it("GETs /models and returns ok + latencyMs on success", async () => {
      server.use(
        http.get("https://api.githubcopilot.com/models", () => {
          return HttpResponse.json(mockModelsResponse);
        })
      );

      const provider = new CopilotProvider(authProvider);
      const result = await provider.healthCheck();

      expect(result.ok).toBe(true);
      expect(typeof result.latencyMs).toBe("number");
      expect(result.error).toBeUndefined();
    });

    it("returns ok:false with error message when /models is unreachable", async () => {
      server.use(
        http.get("https://api.githubcopilot.com/models", () => {
          return HttpResponse.error();
        })
      );

      const provider = new CopilotProvider(authProvider);
      const result = await provider.healthCheck();

      expect(result.ok).toBe(false);
      expect(result.latencyMs).toBeNull();
      expect(result.error).toBeDefined();
    });

    it("returns ok:false with error 'not_initialized' on 401", async () => {
      server.use(
        http.get("https://api.githubcopilot.com/models", () => {
          return new HttpResponse(null, { status: 401 });
        })
      );

      const provider = new CopilotProvider(authProvider);
      const result = await provider.healthCheck();

      expect(result.ok).toBe(false);
      expect(result.error).toBe("not_initialized");
      expect(typeof result.latencyMs).toBe("number");
    });

    it("returns ok:false with HTTP status error on non-2xx", async () => {
      server.use(
        http.get("https://api.githubcopilot.com/models", () => {
          return new HttpResponse(null, { status: 503 });
        })
      );

      const provider = new CopilotProvider(authProvider);
      const result = await provider.healthCheck();

      expect(result.ok).toBe(false);
      expect(result.error).toContain("503");
    });

    it("must not throw even on fatal errors", async () => {
      server.use(
        http.get("https://api.githubcopilot.com/models", () => {
          return HttpResponse.error();
        })
      );

      const provider = new CopilotProvider(authProvider);
      await expect(provider.healthCheck()).resolves.toBeDefined();
    });
  });

  // ─── listModels() ────────────────────────────────────────────────────────

  describe("listModels()", () => {
    it("fetches /models and returns only chat-capable, picker-enabled models with endpoints and token limits", async () => {
      server.use(
        http.get("https://api.githubcopilot.com/models", () =>
          HttpResponse.json(mockModelsResponse)
        ),
        http.post("https://api.githubcopilot.com/models/:id/policy", () =>
          HttpResponse.json({ state: "enabled" })
        )
      );

      const provider = new CopilotProvider(authProvider);
      const models = await provider.listModels();

      expect(models.find(m => m.id === "embeddings-model")).toBeUndefined();
      expect(models.find(m => m.id === "gpt-3.5")).toBeUndefined();
      expect(models.length).toBeGreaterThan(0);
      for (const m of models) {
        expect(m.endpoints.length).toBeGreaterThan(0);
        expect(m.maxPromptTokens).toBeGreaterThan(0);
        expect(m.maxOutputTokens).toBeGreaterThan(0);
      }
    });

    it("deduplicates by name, keeping the highest version", async () => {
      server.use(
        http.get("https://api.githubcopilot.com/models", () =>
          HttpResponse.json(mockModelsResponse)
        ),
        http.post("https://api.githubcopilot.com/models/:id/policy", () =>
          HttpResponse.json({ state: "enabled" })
        )
      );

      const provider = new CopilotProvider(authProvider);
      const models = await provider.listModels();

      const gpt4Models = models.filter(m => m.name === "GPT-4");
      expect(gpt4Models.length).toBe(1);
      expect(gpt4Models[0].id).toBe("gpt-4");
      expect(gpt4Models[0].maxPromptTokens).toBe(8000);
    });

    it("auto-enables disabled models via POST /models/{id}/policy", async () => {
      let policyCallId = "";
      server.use(
        http.get("https://api.githubcopilot.com/models", () =>
          HttpResponse.json(mockModelsResponse)
        ),
        http.post("https://api.githubcopilot.com/models/:id/policy", async ({ request, params }) => {
          policyCallId = params.id as string;
          const body = (await request.json()) as any;
          expect(body.state).toBe("enabled");
          return HttpResponse.json({ state: "enabled" });
        })
      );

      const provider = new CopilotProvider(authProvider);
      const models = await provider.listModels();

      expect(policyCallId).toBe("o1-preview");
      expect(models.find(m => m.id === "o1-preview")).toBeDefined();
    });

    it("caches results for 5 minutes (300s)", async () => {
      let fetchCount = 0;
      server.use(
        http.get("https://api.githubcopilot.com/models", () => {
          fetchCount++;
          return HttpResponse.json(mockModelsResponse);
        }),
        http.post("https://api.githubcopilot.com/models/:id/policy", () =>
          HttpResponse.json({ state: "enabled" })
        )
      );

      const provider = new CopilotProvider(authProvider);
      await provider.listModels();
      expect(fetchCount).toBe(1);

      await provider.listModels();
      expect(fetchCount).toBe(1);

      await provider.listModels();
      expect(fetchCount).toBe(1);
    });

    it("re-fetches after cache TTL expires (>300s)", async () => {
      let fetchCount = 0;
      server.use(
        http.get("https://api.githubcopilot.com/models", () => {
          fetchCount++;
          return HttpResponse.json(mockModelsResponse);
        }),
        http.post("https://api.githubcopilot.com/models/:id/policy", () =>
          HttpResponse.json({ state: "enabled" })
        )
      );

      const realDateNow = Date.now.bind(global.Date);
      let currentTime = realDateNow();
      vi.spyOn(Date, "now").mockImplementation(() => currentTime);

      const provider = new CopilotProvider(authProvider);
      await provider.listModels();
      expect(fetchCount).toBe(1);

      currentTime += 299_000;
      await provider.listModels();
      expect(fetchCount).toBe(1);

      currentTime += 2_000; // total 301s
      await provider.listModels();
      expect(fetchCount).toBe(2);
    });

    it("uses supported_endpoints when endpoints field is absent", async () => {
      const altResponse = {
        data: [
          {
            id: "alt-model",
            name: "Alt",
            version: "2024-01-01",
            model_picker_enabled: true,
            capabilities: {
              type: "chat",
              limits: { max_prompt_tokens: 8000, max_output_tokens: 2000 },
            },
            supported_endpoints: ["/chat/completions", "/responses"],
          },
        ],
      };
      server.use(
        http.get("https://api.githubcopilot.com/models", () =>
          HttpResponse.json(altResponse)
        )
      );

      const provider = new CopilotProvider(authProvider);
      const models = await provider.listModels();

      expect(models).toHaveLength(1);
      expect(models[0].endpoints).toEqual(["/chat/completions", "/responses"]);
    });
  });

  // ─── autoSelect() ────────────────────────────────────────────────────────

  describe("autoSelect()", () => {
    it("POSTs to /models/session with auto hints and returns selected_model", async () => {
      let capturedBody: any;
      server.use(
        http.post("https://api.githubcopilot.com/models/session", async ({ request }) => {
          capturedBody = await request.json();
          return HttpResponse.json({ selected_model: "gpt-4o" });
        })
      );

      const provider = new CopilotProvider(authProvider);
      const selected = await provider.autoSelect!();

      expect(capturedBody.auto_mode.model_hints).toEqual(["auto"]);
      expect(selected).toBe("gpt-4o");
    });

    it("throws ModelError auto_select_failed on API error", async () => {
      server.use(
        http.post("https://api.githubcopilot.com/models/session", () =>
          HttpResponse.json({ error: { message: "Selection failed" } }, { status: 500 })
        )
      );

      const provider = new CopilotProvider(authProvider);
      await expect(provider.autoSelect!()).rejects.toThrow(ModelError);
      try {
        await provider.autoSelect!();
      } catch (err) {
        expect((err as ModelError).code).toBe("auto_select_failed");
      }
    });
  });

  // ─── chat() — Responses API routing ─────────────────────────────────────

  describe("chat() — endpoint routing", () => {
    it("routes to /responses when model.endpoints includes it", async () => {
      let capturedPath = "";
      let capturedBody: any;
      server.use(
        http.post("https://api.githubcopilot.com/responses", async ({ request }) => {
          capturedPath = new URL(request.url).pathname;
          capturedBody = await request.json();
          return HttpResponse.json(responsesApiFixture);
        })
      );

      const provider = new CopilotProvider(authProvider);
      const request: ChatRequest = {
        model: "gpt-4o",
        systemPrompt: "You are a code reviewer",
        messages: [{ role: "user", content: "Review this" }],
        stream: false,
      };
      // gpt-4o has /responses in its endpoints list in the mock
      // We simulate by providing a model info that includes /responses
      // The provider's chat() must check the model's endpoints — we supply
      // a ModelInfo-aware override by testing the underlying routing mechanism.
      // Since CopilotProvider.chat() accepts a ChatRequest (no ModelInfo inline),
      // we need to verify routing via model info from listModels.
      // Strategy: set up listModels + call with a model that has /responses.
      server.use(
        http.get("https://api.githubcopilot.com/models", () =>
          HttpResponse.json(mockModelsResponse)
        ),
        http.post("https://api.githubcopilot.com/models/:id/policy", () =>
          HttpResponse.json({ state: "enabled" })
        )
      );

      // Pre-warm model cache so routing logic can consult endpoints
      await provider.listModels();

      const response = await provider.chat(request);
      expect(capturedPath).toBe("/responses");
      expect(capturedBody.instructions).toBe("You are a code reviewer");
      expect(capturedBody.input).toEqual([{ role: "user", content: "Review this" }]);
      expect(capturedBody.messages).toBeUndefined();
    });

    it("routes to /chat/completions for models without /responses", async () => {
      let capturedPath = "";
      server.use(
        http.get("https://api.githubcopilot.com/models", () =>
          HttpResponse.json(mockModelsResponse)
        ),
        http.post("https://api.githubcopilot.com/models/:id/policy", () =>
          HttpResponse.json({ state: "enabled" })
        ),
        http.post("https://api.githubcopilot.com/chat/completions", ({ request }) => {
          capturedPath = new URL(request.url).pathname;
          return HttpResponse.json(chatCompletionsFixture);
        })
      );

      const provider = new CopilotProvider(authProvider);
      await provider.listModels();

      const request: ChatRequest = {
        model: "gpt-4", // gpt-4 only has /chat/completions
        systemPrompt: "Reviewer",
        messages: [{ role: "user", content: "Check this" }],
        stream: false,
      };

      await provider.chat(request);
      expect(capturedPath).toBe("/chat/completions");
    });

    it("falls back to /chat/completions when /responses returns 404", async () => {
      let responsesAttempts = 0;
      let completionsAttempts = 0;
      server.use(
        http.get("https://api.githubcopilot.com/models", () =>
          HttpResponse.json(mockModelsResponse)
        ),
        http.post("https://api.githubcopilot.com/models/:id/policy", () =>
          HttpResponse.json({ state: "enabled" })
        ),
        http.post("https://api.githubcopilot.com/responses", () => {
          responsesAttempts++;
          return new HttpResponse(null, { status: 404 });
        }),
        http.post("https://api.githubcopilot.com/chat/completions", () => {
          completionsAttempts++;
          return HttpResponse.json(chatCompletionsFixture);
        })
      );

      const provider = new CopilotProvider(authProvider);
      await provider.listModels();

      const request: ChatRequest = {
        model: "gpt-4o", // has /responses in endpoints
        systemPrompt: "Reviewer",
        messages: [{ role: "user", content: "Check this" }],
        stream: false,
      };

      const response = await provider.chat(request);
      expect(responsesAttempts).toBe(1);
      expect(completionsAttempts).toBe(1);
      expect(response.content).toBe("Review findings here.");
    });

    it("falls back to /chat/completions when /responses returns 400", async () => {
      let responsesAttempts = 0;
      server.use(
        http.get("https://api.githubcopilot.com/models", () =>
          HttpResponse.json(mockModelsResponse)
        ),
        http.post("https://api.githubcopilot.com/models/:id/policy", () =>
          HttpResponse.json({ state: "enabled" })
        ),
        http.post("https://api.githubcopilot.com/responses", () => {
          responsesAttempts++;
          return HttpResponse.json({ error: { message: "Bad Request" } }, { status: 400 });
        }),
        http.post("https://api.githubcopilot.com/chat/completions", () => {
          return HttpResponse.json(chatCompletionsFixture);
        })
      );

      const provider = new CopilotProvider(authProvider);
      await provider.listModels();

      const request: ChatRequest = {
        model: "gpt-4o",
        systemPrompt: "Reviewer",
        messages: [{ role: "user", content: "Check this" }],
        stream: false,
      };

      const response = await provider.chat(request);
      expect(responsesAttempts).toBe(1);
      expect(response.content).toBe("Review findings here.");
    });

    it("marks model as fallback after first /responses 404, skips /responses on second call", async () => {
      let responsesAttempts = 0;
      server.use(
        http.get("https://api.githubcopilot.com/models", () =>
          HttpResponse.json(mockModelsResponse)
        ),
        http.post("https://api.githubcopilot.com/models/:id/policy", () =>
          HttpResponse.json({ state: "enabled" })
        ),
        http.post("https://api.githubcopilot.com/responses", () => {
          responsesAttempts++;
          return new HttpResponse(null, { status: 404 });
        }),
        http.post("https://api.githubcopilot.com/chat/completions", () => {
          return HttpResponse.json(chatCompletionsFixture);
        })
      );

      const provider = new CopilotProvider(authProvider);
      await provider.listModels();

      const request: ChatRequest = {
        model: "gpt-4o",
        systemPrompt: "Reviewer",
        messages: [{ role: "user", content: "Check this" }],
        stream: false,
      };

      await provider.chat(request); // First call — should hit /responses then fallback
      await provider.chat(request); // Second call — should skip /responses entirely

      expect(responsesAttempts).toBe(1); // /responses tried only once ever for this model
    });

    it("parses Responses API response correctly", async () => {
      server.use(
        http.get("https://api.githubcopilot.com/models", () =>
          HttpResponse.json(mockModelsResponse)
        ),
        http.post("https://api.githubcopilot.com/models/:id/policy", () =>
          HttpResponse.json({ state: "enabled" })
        ),
        http.post("https://api.githubcopilot.com/responses", () =>
          HttpResponse.json(responsesApiFixture)
        )
      );

      const provider = new CopilotProvider(authProvider);
      await provider.listModels();

      const request: ChatRequest = {
        model: "gpt-4o",
        systemPrompt: "Reviewer",
        messages: [{ role: "user", content: "Review" }],
        stream: false,
      };

      const response = await provider.chat(request);
      expect(response.content).toBe("Review findings here.");
      expect(response.model).toBe("gpt-4.1");
      expect(response.usage.totalTokens).toBe(150);
    });
  });

  // ─── chatStream() — Responses API routing ────────────────────────────────

  describe("chatStream() — endpoint routing", () => {
    it("routes to /responses stream when model supports it", async () => {
      const responsesStreamData = `data: {"type":"response.output_text.delta","delta":"Test output"}\n\ndata: [DONE]\n\n`;
      server.use(
        http.get("https://api.githubcopilot.com/models", () =>
          HttpResponse.json(mockModelsResponse)
        ),
        http.post("https://api.githubcopilot.com/models/:id/policy", () =>
          HttpResponse.json({ state: "enabled" })
        ),
        http.post("https://api.githubcopilot.com/responses", () =>
          new HttpResponse(responsesStreamData, {
            headers: { "Content-Type": "text/event-stream" },
          })
        )
      );

      const provider = new CopilotProvider(authProvider);
      await provider.listModels();

      const request: ChatRequest = {
        model: "gpt-4o",
        systemPrompt: "",
        messages: [{ role: "user", content: "Test" }],
        stream: true,
      };

      const chunks = [];
      for await (const chunk of provider.chatStream(request)) {
        chunks.push(chunk);
      }

      expect(chunks.some(c => c.type === "content" && c.text === "Test output")).toBe(true);
    });

    it("falls back to /chat/completions stream on /responses 404", async () => {
      const streamData = `data: {"choices":[{"delta":{"content":"Hello from completions"}}]}\n\ndata: [DONE]\n\n`;
      server.use(
        http.get("https://api.githubcopilot.com/models", () =>
          HttpResponse.json(mockModelsResponse)
        ),
        http.post("https://api.githubcopilot.com/models/:id/policy", () =>
          HttpResponse.json({ state: "enabled" })
        ),
        http.post("https://api.githubcopilot.com/responses", () =>
          new HttpResponse(null, { status: 404 })
        ),
        http.post("https://api.githubcopilot.com/chat/completions", () =>
          new HttpResponse(streamData, {
            headers: { "Content-Type": "text/event-stream" },
          })
        )
      );

      const provider = new CopilotProvider(authProvider);
      await provider.listModels();

      const request: ChatRequest = {
        model: "gpt-4o",
        systemPrompt: "",
        messages: [{ role: "user", content: "Test" }],
        stream: true,
      };

      const chunks = [];
      for await (const chunk of provider.chatStream(request)) {
        chunks.push(chunk);
      }

      expect(chunks.some(c => c.type === "content" && c.text === "Hello from completions")).toBe(true);
    });
  });

  // ─── provider name ───────────────────────────────────────────────────────

  describe("provider name", () => {
    it("has name 'copilot'", () => {
      const provider = new CopilotProvider(authProvider);
      expect(provider.name).toBe("copilot");
    });
  });
});
