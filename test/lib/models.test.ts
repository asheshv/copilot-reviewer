// test/lib/models.test.ts

import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { ModelManager } from "../../src/lib/models.js";
import type { AuthProvider } from "../../src/lib/types.js";
import { ModelError } from "../../src/lib/types.js";

// Mock AuthProvider
class MockAuthProvider implements AuthProvider {
  async getAuthenticatedHeaders(): Promise<Record<string, string>> {
    return {
      Authorization: "Bearer test-token",
    };
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

// Mock models API response
const mockModelsResponse = {
  data: [
    {
      id: "gpt-4",
      name: "GPT-4",
      version: "2024-01-01",
      model_picker_enabled: true,
      capabilities: {
        type: "chat",
        limits: {
          max_prompt_tokens: 8000,
          max_output_tokens: 2000,
        },
      },
      endpoints: ["/chat/completions"],
      streaming: true,
      tool_calls: true,
      tokenizer: "cl100k_base",
      policy: {
        state: "enabled",
      },
    },
    {
      id: "gpt-4o",
      name: "GPT-4o",
      version: "2024-02-01",
      model_picker_enabled: true,
      capabilities: {
        type: "chat",
        limits: {
          max_prompt_tokens: 128000,
          max_output_tokens: 16384,
        },
      },
      endpoints: ["/chat/completions", "/responses"],
      streaming: true,
      tool_calls: true,
      tokenizer: "o200k_base",
      policy: {
        state: "enabled",
      },
    },
    {
      id: "o1-preview",
      name: "o1-preview",
      version: "2024-03-01",
      model_picker_enabled: true,
      capabilities: {
        type: "chat",
        limits: {
          max_prompt_tokens: 32000,
          max_output_tokens: 8000,
        },
      },
      endpoints: ["/chat/completions"],
      streaming: false,
      tool_calls: false,
      tokenizer: "o200k_base",
      policy: {
        state: "disabled",
      },
    },
    {
      // Should be filtered out - not chat capable
      id: "embeddings-model",
      name: "Embeddings",
      version: "2024-01-01",
      model_picker_enabled: true,
      capabilities: {
        type: "embeddings",
        limits: {
          max_prompt_tokens: 8000,
          max_output_tokens: 0,
        },
      },
      endpoints: ["/embeddings"],
      streaming: false,
      tool_calls: false,
      tokenizer: "cl100k_base",
    },
    {
      // Should be filtered out - not picker enabled
      id: "gpt-3.5",
      name: "GPT-3.5",
      version: "2024-01-01",
      model_picker_enabled: false,
      capabilities: {
        type: "chat",
        limits: {
          max_prompt_tokens: 4000,
          max_output_tokens: 1000,
        },
      },
      endpoints: ["/chat/completions"],
      streaming: true,
      tool_calls: true,
      tokenizer: "cl100k_base",
    },
    {
      // Duplicate name, older version (should be filtered)
      id: "gpt-4-old",
      name: "GPT-4",
      version: "2023-12-01",
      model_picker_enabled: true,
      capabilities: {
        type: "chat",
        limits: {
          max_prompt_tokens: 6000,
          max_output_tokens: 1500,
        },
      },
      endpoints: ["/chat/completions"],
      streaming: true,
      tool_calls: true,
      tokenizer: "cl100k_base",
      policy: {
        state: "enabled",
      },
    },
    {
      // Model without policy field (should be considered enabled)
      id: "claude-3",
      name: "Claude-3",
      version: "2024-01-01",
      model_picker_enabled: true,
      capabilities: {
        type: "chat",
        limits: {
          max_prompt_tokens: 100000,
          max_output_tokens: 4096,
        },
      },
      endpoints: ["/chat/completions"],
      streaming: true,
      tool_calls: true,
      tokenizer: "claude",
    },
  ],
};

describe("ModelManager", () => {
  const authProvider = new MockAuthProvider();

  describe("listModels()", () => {
    it("fetches from /models and returns ModelInfo array", async () => {
      server.use(
        http.get("https://api.githubcopilot.com/models", () => {
          return HttpResponse.json(mockModelsResponse);
        }),
        http.post("https://api.githubcopilot.com/models/:id/policy", () => {
          return HttpResponse.json({ state: "enabled" });
        })
      );

      const manager = new ModelManager(authProvider);
      const models = await manager.listModels();

      expect(models.length).toBeGreaterThan(0);
      expect(models[0]).toHaveProperty("id");
      expect(models[0]).toHaveProperty("name");
      expect(models[0]).toHaveProperty("endpoints");
    });

    it("filters to capabilities.type chat and model_picker_enabled", async () => {
      server.use(
        http.get("https://api.githubcopilot.com/models", () => {
          return HttpResponse.json(mockModelsResponse);
        }),
        http.post("https://api.githubcopilot.com/models/:id/policy", () => {
          return HttpResponse.json({ state: "enabled" });
        })
      );

      const manager = new ModelManager(authProvider);
      const models = await manager.listModels();

      // Should not include embeddings-model or gpt-3.5
      expect(models.find(m => m.id === "embeddings-model")).toBeUndefined();
      expect(models.find(m => m.id === "gpt-3.5")).toBeUndefined();
    });

    it("deduplicates by name, keeps highest version", async () => {
      server.use(
        http.get("https://api.githubcopilot.com/models", () => {
          return HttpResponse.json(mockModelsResponse);
        }),
        http.post("https://api.githubcopilot.com/models/:id/policy", () => {
          return HttpResponse.json({ state: "enabled" });
        })
      );

      const manager = new ModelManager(authProvider);
      const models = await manager.listModels();

      // Should have only one GPT-4 (the newer version)
      const gpt4Models = models.filter(m => m.name === "GPT-4");
      expect(gpt4Models.length).toBe(1);
      expect(gpt4Models[0].id).toBe("gpt-4");
      expect(gpt4Models[0].maxPromptTokens).toBe(8000);
    });

    it("auto-enables models with disabled policy via POST /models/{id}/policy", async () => {
      let policyCallCount = 0;
      let policyCallId = "";

      server.use(
        http.get("https://api.githubcopilot.com/models", () => {
          return HttpResponse.json(mockModelsResponse);
        }),
        http.post("https://api.githubcopilot.com/models/:id/policy", async ({ request, params }) => {
          policyCallCount++;
          policyCallId = params.id as string;
          const body = await request.json() as any;
          expect(body.state).toBe("enabled");
          return HttpResponse.json({ state: "enabled" });
        })
      );

      const manager = new ModelManager(authProvider);
      const models = await manager.listModels();

      // Should have called policy enable for o1-preview
      expect(policyCallCount).toBe(1);
      expect(policyCallId).toBe("o1-preview");

      // Should include o1-preview in results
      expect(models.find(m => m.id === "o1-preview")).toBeDefined();
    });

    it("skips policy check when policy field is absent", async () => {
      let policyCallCount = 0;

      server.use(
        http.get("https://api.githubcopilot.com/models", () => {
          return HttpResponse.json(mockModelsResponse);
        }),
        http.post("https://api.githubcopilot.com/models/:id/policy", () => {
          policyCallCount++;
          return HttpResponse.json({ state: "enabled" });
        })
      );

      const manager = new ModelManager(authProvider);
      const models = await manager.listModels();

      // Should include claude-3 even though it has no policy field
      expect(models.find(m => m.id === "claude-3")).toBeDefined();

      // Should NOT have called policy for claude-3 (only for o1-preview)
      expect(policyCallCount).toBe(1); // Only o1-preview has disabled policy
    });

    it("caches results for 300 seconds", async () => {
      let fetchCount = 0;

      server.use(
        http.get("https://api.githubcopilot.com/models", () => {
          fetchCount++;
          return HttpResponse.json(mockModelsResponse);
        }),
        http.post("https://api.githubcopilot.com/models/:id/policy", () => {
          return HttpResponse.json({ state: "enabled" });
        })
      );

      const manager = new ModelManager(authProvider);

      // First call - should fetch
      await manager.listModels();
      expect(fetchCount).toBe(1);

      // Second call - should use cache
      await manager.listModels();
      expect(fetchCount).toBe(1);

      // Third call - should still use cache
      await manager.listModels();
      expect(fetchCount).toBe(1);
    });

    it("re-fetches after cache TTL expires", async () => {
      let fetchCount = 0;

      server.use(
        http.get("https://api.githubcopilot.com/models", () => {
          fetchCount++;
          return HttpResponse.json(mockModelsResponse);
        }),
        http.post("https://api.githubcopilot.com/models/:id/policy", () => {
          return HttpResponse.json({ state: "enabled" });
        })
      );

      // Mock Date.now to control time
      const realDateNow = Date.now.bind(global.Date);
      let currentTime = realDateNow();
      vi.spyOn(Date, "now").mockImplementation(() => currentTime);

      const manager = new ModelManager(authProvider);

      // First call - should fetch
      await manager.listModels();
      expect(fetchCount).toBe(1);

      // Advance time by 299 seconds - should still use cache
      currentTime += 299_000;
      await manager.listModels();
      expect(fetchCount).toBe(1);

      // Advance time by 2 more seconds (total 301) - should re-fetch
      currentTime += 2_000;
      await manager.listModels();
      expect(fetchCount).toBe(2);
    });
    it("normalizes missing/optional fields with safe defaults", async () => {
      const sparseResponse = {
        data: [
          {
            id: "sparse-model",
            name: "Sparse",
            version: "2024-01-01",
            model_picker_enabled: true,
            capabilities: {
              type: "chat",
              limits: {
                max_prompt_tokens: 4000,
                max_output_tokens: 1000,
              },
            },
            // No endpoints, streaming, tool_calls, or tokenizer fields
          },
        ],
      };

      server.use(
        http.get("https://api.githubcopilot.com/models", () => {
          return HttpResponse.json(sparseResponse);
        })
      );

      const manager = new ModelManager(authProvider);
      const models = await manager.listModels();

      expect(models).toHaveLength(1);
      expect(models[0].endpoints).toEqual([]);
      expect(models[0].streaming).toBe(false);
      expect(models[0].toolCalls).toBe(false);
      expect(models[0].tokenizer).toBe("o200k_base");
      expect(models[0].maxPromptTokens).toBe(4000);
      expect(models[0].maxOutputTokens).toBe(1000);
    });

    it("uses supported_endpoints when endpoints is absent", async () => {
      const altResponse = {
        data: [
          {
            id: "alt-model",
            name: "Alt",
            version: "2024-01-01",
            model_picker_enabled: true,
            capabilities: {
              type: "chat",
              limits: {
                max_prompt_tokens: 8000,
                max_output_tokens: 2000,
              },
            },
            supported_endpoints: ["/chat/completions", "/responses"],
          },
        ],
      };

      server.use(
        http.get("https://api.githubcopilot.com/models", () => {
          return HttpResponse.json(altResponse);
        })
      );

      const manager = new ModelManager(authProvider);
      const models = await manager.listModels();

      expect(models).toHaveLength(1);
      expect(models[0].endpoints).toEqual(["/chat/completions", "/responses"]);
    });
  });

  describe("autoSelect()", () => {
    it("calls POST /models/session with auto hints", async () => {
      let capturedBody: any;

      server.use(
        http.post("https://api.githubcopilot.com/models/session", async ({ request }) => {
          capturedBody = await request.json();
          return HttpResponse.json({ selected_model: "gpt-4o" });
        })
      );

      const manager = new ModelManager(authProvider);
      const model = await manager.autoSelect();

      expect(capturedBody.auto_mode.model_hints).toEqual(["auto"]);
      expect(model).toBe("gpt-4o");
    });

    it("returns selected_model string", async () => {
      server.use(
        http.post("https://api.githubcopilot.com/models/session", () => {
          return HttpResponse.json({ selected_model: "claude-3" });
        })
      );

      const manager = new ModelManager(authProvider);
      const model = await manager.autoSelect();

      expect(typeof model).toBe("string");
      expect(model).toBe("claude-3");
    });

    it("throws ModelError auto_select_failed on API error", async () => {
      server.use(
        http.post("https://api.githubcopilot.com/models/session", () => {
          return HttpResponse.json(
            { error: { message: "Selection failed" } },
            { status: 500 }
          );
        })
      );

      const manager = new ModelManager(authProvider);

      await expect(manager.autoSelect()).rejects.toThrow(ModelError);
      try {
        await manager.autoSelect();
      } catch (error) {
        expect(error).toBeInstanceOf(ModelError);
        expect((error as ModelError).code).toBe("auto_select_failed");
      }
    });
  });

  describe("validateModel()", () => {
    it("returns ModelInfo for valid model ID", async () => {
      server.use(
        http.get("https://api.githubcopilot.com/models", () => {
          return HttpResponse.json(mockModelsResponse);
        }),
        http.post("https://api.githubcopilot.com/models/:id/policy", () => {
          return HttpResponse.json({ state: "enabled" });
        })
      );

      const manager = new ModelManager(authProvider);
      const model = await manager.validateModel("gpt-4");

      expect(model).toBeDefined();
      expect(model.id).toBe("gpt-4");
      expect(model.name).toBe("GPT-4");
    });

    it("throws ModelError model_not_found with available list for invalid ID", async () => {
      server.use(
        http.get("https://api.githubcopilot.com/models", () => {
          return HttpResponse.json(mockModelsResponse);
        }),
        http.post("https://api.githubcopilot.com/models/:id/policy", () => {
          return HttpResponse.json({ state: "enabled" });
        })
      );

      const manager = new ModelManager(authProvider);

      try {
        await manager.validateModel("nonexistent-model");
        expect.fail("Expected error to be thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ModelError);
        expect((error as ModelError).code).toBe("model_not_found");
        expect((error as ModelError).message).toContain("nonexistent-model");
        expect((error as ModelError).message).toContain("Available:");
        expect((error as ModelError).available).toBeDefined();
        expect((error as ModelError).available!.length).toBeGreaterThan(0);
      }
    });
  });

  describe("headers", () => {
    it("includes all 6 required headers on every request", async () => {
      let capturedHeaders: Headers;

      server.use(
        http.get("https://api.githubcopilot.com/models", ({ request }) => {
          capturedHeaders = request.headers;
          return HttpResponse.json(mockModelsResponse);
        }),
        http.post("https://api.githubcopilot.com/models/:id/policy", () => {
          return HttpResponse.json({ state: "enabled" });
        })
      );

      const manager = new ModelManager(authProvider);
      await manager.listModels();

      expect(capturedHeaders!.get("Editor-Version")).toBe("copilot-reviewer/0.1.0");
      expect(capturedHeaders!.get("Editor-Plugin-Version")).toBe("copilot-reviewer/0.1.0");
      expect(capturedHeaders!.get("Copilot-Integration-Id")).toBe("vscode-chat");
      expect(capturedHeaders!.get("x-github-api-version")).toBe("2025-10-01");
      expect(capturedHeaders!.get("Content-Type")).toBe("application/json");
      expect(capturedHeaders!.get("Authorization")).toBe("Bearer test-token");
    });
  });
});
