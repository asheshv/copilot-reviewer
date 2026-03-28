// test/lib/client.test.ts

import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { CopilotClient } from "../../src/lib/client.js";
import type { AuthProvider, ChatRequest, Message } from "../../src/lib/types.js";
import { ClientError } from "../../src/lib/types.js";
import chatCompletionsFixture from "../fixtures/responses/chat-completions-non-streaming.json";
import responsesApiFixture from "../fixtures/responses/responses-api-non-streaming.json";

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
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("CopilotClient", () => {
  const authProvider = new MockAuthProvider();

  describe("endpoint routing", () => {
    it("uses Responses API when useResponsesApi is true", async () => {
      let capturedPath = "";
      let capturedBody: any;
      server.use(
        http.post("https://api.githubcopilot.com/responses", async ({ request }) => {
          capturedPath = new URL(request.url).pathname;
          capturedBody = await request.json();
          return HttpResponse.json(responsesApiFixture);
        })
      );

      const client = new CopilotClient(authProvider);
      const request: ChatRequest = {
        model: "gpt-4o",
        systemPrompt: "You are a code reviewer",
        messages: [{ role: "user", content: "Review this code" }],
        stream: false,
      };

      await client.chat(request, true);
      expect(capturedPath).toBe("/responses");

      // Verify Responses API body format
      expect(capturedBody.instructions).toBe("You are a code reviewer");
      expect(capturedBody.input).toEqual([{ role: "user", content: "Review this code" }]);
      expect(capturedBody.messages).toBeUndefined();
    });

    it("uses Chat Completions when useResponsesApi is false or omitted", async () => {
      let capturedPath = "";
      server.use(
        http.post("https://api.githubcopilot.com/chat/completions", ({ request }) => {
          capturedPath = new URL(request.url).pathname;
          return HttpResponse.json(chatCompletionsFixture);
        })
      );

      const client = new CopilotClient(authProvider);
      const request: ChatRequest = {
        model: "gpt-4",
        systemPrompt: "You are a code reviewer",
        messages: [{ role: "user", content: "Review this code" }],
        stream: false,
      };

      await client.chat(request, false);
      expect(capturedPath).toBe("/chat/completions");
    });
  });

  describe("o1 model handling", () => {
    it("demotes system role to user for o1 models", async () => {
      let capturedBody: any;
      server.use(
        http.post("https://api.githubcopilot.com/chat/completions", async ({ request }) => {
          capturedBody = await request.json();
          return HttpResponse.json(chatCompletionsFixture);
        })
      );

      const client = new CopilotClient(authProvider);
      const request: ChatRequest = {
        model: "o1-preview",
        systemPrompt: "You are a code reviewer",
        messages: [{ role: "user", content: "Review this code" }],
        stream: false,
      };

      await client.chat(request, false);

      // System prompt should be demoted to user message
      expect(capturedBody.messages[0].role).toBe("user");
      expect(capturedBody.messages[0].content).toBe("You are a code reviewer");
    });

    it("omits temperature, n, top_p for o1 models", async () => {
      let capturedBody: any;
      server.use(
        http.post("https://api.githubcopilot.com/chat/completions", async ({ request }) => {
          capturedBody = await request.json();
          return HttpResponse.json(chatCompletionsFixture);
        })
      );

      const client = new CopilotClient(authProvider);
      const request: ChatRequest = {
        model: "o1-mini",
        systemPrompt: "You are a code reviewer",
        messages: [{ role: "user", content: "Review this code" }],
        stream: false,
      };

      await client.chat(request, false);

      expect(capturedBody.temperature).toBeUndefined();
      expect(capturedBody.n).toBeUndefined();
      expect(capturedBody.top_p).toBeUndefined();
    });
  });

  describe("required headers", () => {
    it("includes all 6 required headers on every request", async () => {
      let capturedHeaders: Headers;
      server.use(
        http.post("https://api.githubcopilot.com/chat/completions", ({ request }) => {
          capturedHeaders = request.headers;
          return HttpResponse.json(chatCompletionsFixture);
        })
      );

      const client = new CopilotClient(authProvider);
      const request: ChatRequest = {
        model: "gpt-4",
        systemPrompt: "You are a code reviewer",
        messages: [{ role: "user", content: "Review this code" }],
        stream: false,
      };

      await client.chat(request, false);

      expect(capturedHeaders!.get("Editor-Version")).toBe("copilot-reviewer/0.1.0");
      expect(capturedHeaders!.get("Editor-Plugin-Version")).toBe("copilot-reviewer/0.1.0");
      expect(capturedHeaders!.get("Copilot-Integration-Id")).toBe("vscode-chat");
      expect(capturedHeaders!.get("x-github-api-version")).toBe("2025-10-01");
      expect(capturedHeaders!.get("Content-Type")).toBe("application/json");
      expect(capturedHeaders!.get("Authorization")).toBe("Bearer test-token");
    });
  });

  describe("chat() non-streaming", () => {
    it("parses Chat Completions response correctly", async () => {
      server.use(
        http.post("https://api.githubcopilot.com/chat/completions", () => {
          return HttpResponse.json(chatCompletionsFixture);
        })
      );

      const client = new CopilotClient(authProvider);
      const request: ChatRequest = {
        model: "gpt-4",
        systemPrompt: "You are a code reviewer",
        messages: [{ role: "user", content: "Review this code" }],
        stream: false,
      };

      const response = await client.chat(request, false);

      expect(response.content).toBe("Review findings here.");
      expect(response.model).toBe("gpt-4.1");
      expect(response.usage.totalTokens).toBe(150);
    });

    it("checks both finish_reason and done_reason fields", async () => {
      const fixtureWithDoneReason = {
        choices: [
          {
            message: { role: "assistant", content: "Done" },
            done_reason: "stop",
          },
        ],
        usage: { total_tokens: 50 },
        model: "gpt-4",
      };

      server.use(
        http.post("https://api.githubcopilot.com/chat/completions", () => {
          return HttpResponse.json(fixtureWithDoneReason);
        })
      );

      const client = new CopilotClient(authProvider);
      const request: ChatRequest = {
        model: "gpt-4",
        systemPrompt: "",
        messages: [{ role: "user", content: "Test" }],
        stream: false,
      };

      const response = await client.chat(request, false);
      expect(response.content).toBe("Done");
    });

    it("checks both reasoning and reasoning_content fields", async () => {
      const fixtureWithReasoningContent = {
        choices: [
          {
            message: {
              role: "assistant",
              content: "Result",
              reasoning_content: "Alternative reasoning",
            },
            finish_reason: "stop",
          },
        ],
        usage: { total_tokens: 50 },
        model: "gpt-4",
      };

      server.use(
        http.post("https://api.githubcopilot.com/chat/completions", () => {
          return HttpResponse.json(fixtureWithReasoningContent);
        })
      );

      const client = new CopilotClient(authProvider);
      const request: ChatRequest = {
        model: "gpt-4",
        systemPrompt: "",
        messages: [{ role: "user", content: "Test" }],
        stream: false,
      };

      const response = await client.chat(request, false);
      expect(response.content).toBe("Result");
    });

    it("parses Responses API response correctly", async () => {
      server.use(
        http.post("https://api.githubcopilot.com/responses", () => {
          return HttpResponse.json(responsesApiFixture);
        })
      );

      const client = new CopilotClient(authProvider);
      const request: ChatRequest = {
        model: "gpt-4o",
        systemPrompt: "You are a code reviewer",
        messages: [{ role: "user", content: "Review this code" }],
        stream: false,
      };

      const response = await client.chat(request, true);

      expect(response.content).toBe("Review findings here.");
      expect(response.model).toBe("gpt-4.1");
      expect(response.usage.totalTokens).toBe(150);
    });

    it("checks response.status for Responses API", async () => {
      const failedResponse = {
        response: {
          status: "failed",
          error: { message: "Something went wrong" },
        },
      };

      server.use(
        http.post("https://api.githubcopilot.com/responses", () => {
          return HttpResponse.json(failedResponse);
        })
      );

      const client = new CopilotClient(authProvider);
      const request: ChatRequest = {
        model: "gpt-4o",
        systemPrompt: "",
        messages: [{ role: "user", content: "Test" }],
        stream: false,
      };

      try {
        await client.chat(request, true);
        expect.fail("Expected error to be thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ClientError);
        expect((error as ClientError).code).toBe("request_failed");
      }
    });

    it("extracts content from output[].content[] with multiple type values", async () => {
      const multiTypeResponse = {
        response: {
          status: "completed",
          output: [
            {
              role: "assistant",
              content: [
                { type: "input_text", text: "Input text" },
                { type: "output_text", text: "Output 1" },
                { type: "text", text: "Text content" },
                { type: "unknown", text: "Should be ignored" },
                { type: "output_text", text: "Output 2" },
              ],
            },
          ],
          usage: { total_tokens: 100 },
          model: "gpt-4o",
        },
      };

      server.use(
        http.post("https://api.githubcopilot.com/responses", () => {
          return HttpResponse.json(multiTypeResponse);
        })
      );

      const client = new CopilotClient(authProvider);
      const request: ChatRequest = {
        model: "gpt-4o",
        systemPrompt: "",
        messages: [{ role: "user", content: "Test" }],
        stream: false,
      };

      const response = await client.chat(request, true);
      expect(response.content).toBe("Input textOutput 1Text contentOutput 2");
    });

    it("handles empty systemPrompt (chat subcommand)", async () => {
      let capturedBody: any;
      server.use(
        http.post("https://api.githubcopilot.com/chat/completions", async ({ request }) => {
          capturedBody = await request.json();
          return HttpResponse.json(chatCompletionsFixture);
        })
      );

      const client = new CopilotClient(authProvider);
      const request: ChatRequest = {
        model: "gpt-4",
        systemPrompt: "",
        messages: [{ role: "user", content: "Review this code" }],
        stream: false,
      };

      await client.chat(request, false);

      // Should not include system message when systemPrompt is empty
      expect(capturedBody.messages.length).toBe(1);
      expect(capturedBody.messages[0].role).toBe("user");
    });
  });

  describe("chatStream()", () => {
    it("returns AsyncIterable of StreamChunk", async () => {
      const streamData = `data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\ndata: [DONE]\n\n`;

      server.use(
        http.post("https://api.githubcopilot.com/chat/completions", () => {
          return new HttpResponse(streamData, {
            headers: {
              "Content-Type": "text/event-stream",
            },
          });
        })
      );

      const client = new CopilotClient(authProvider);
      const request: ChatRequest = {
        model: "gpt-4",
        systemPrompt: "You are a code reviewer",
        messages: [{ role: "user", content: "Review this code" }],
        stream: true,
      };

      const chunks = [];
      for await (const chunk of client.chatStream(request, false)) {
        chunks.push(chunk);
      }

      expect(chunks.length).toBe(2);
      expect(chunks[0].type).toBe("content");
      expect(chunks[0].text).toBe("Hello");
      expect(chunks[1].type).toBe("content");
      expect(chunks[1].text).toBe(" world");
    });

    it("delegates to streaming.ts parsers based on API format", async () => {
      const responsesStreamData = `data: {"type":"response.output_text.delta","delta":"Test"}\n\ndata: [DONE]\n\n`;

      server.use(
        http.post("https://api.githubcopilot.com/responses", () => {
          return new HttpResponse(responsesStreamData, {
            headers: {
              "Content-Type": "text/event-stream",
            },
          });
        })
      );

      const client = new CopilotClient(authProvider);
      const request: ChatRequest = {
        model: "gpt-4o",
        systemPrompt: "",
        messages: [{ role: "user", content: "Test" }],
        stream: true,
      };

      const chunks = [];
      for await (const chunk of client.chatStream(request, true)) {
        chunks.push(chunk);
      }

      expect(chunks.length).toBe(1);
      expect(chunks[0].type).toBe("content");
      expect(chunks[0].text).toBe("Test");
    });
  });

  describe("retry logic", () => {
    it("retries on 429 with retry-after header", async () => {
      let attemptCount = 0;
      server.use(
        http.post("https://api.githubcopilot.com/chat/completions", () => {
          attemptCount++;
          if (attemptCount === 1) {
            return new HttpResponse(null, {
              status: 429,
              headers: {
                "retry-after": "1",
              },
            });
          }
          return HttpResponse.json(chatCompletionsFixture);
        })
      );

      const client = new CopilotClient(authProvider);
      const request: ChatRequest = {
        model: "gpt-4",
        systemPrompt: "",
        messages: [{ role: "user", content: "Test" }],
        stream: false,
      };

      const response = await client.chat(request, false);
      expect(attemptCount).toBe(2);
      expect(response.content).toBe("Review findings here.");
    });

    it("retries on 502/503/504 with exponential backoff", async () => {
      let attemptCount = 0;
      server.use(
        http.post("https://api.githubcopilot.com/chat/completions", () => {
          attemptCount++;
          if (attemptCount === 1) {
            return new HttpResponse(null, { status: 502 });
          }
          if (attemptCount === 2) {
            return new HttpResponse(null, { status: 503 });
          }
          return HttpResponse.json(chatCompletionsFixture);
        })
      );

      const client = new CopilotClient(authProvider);
      const request: ChatRequest = {
        model: "gpt-4",
        systemPrompt: "",
        messages: [{ role: "user", content: "Test" }],
        stream: false,
      };

      const response = await client.chat(request, false);
      expect(attemptCount).toBe(3);
      expect(response.content).toBe("Review findings here.");
    });

    it("retries on network timeout", async () => {
      let attemptCount = 0;
      server.use(
        http.post("https://api.githubcopilot.com/chat/completions", () => {
          attemptCount++;
          if (attemptCount === 1) {
            // Simulate network error by returning network error response
            return HttpResponse.error();
          }
          return HttpResponse.json(chatCompletionsFixture);
        })
      );

      const client = new CopilotClient(authProvider);
      const request: ChatRequest = {
        model: "gpt-4",
        systemPrompt: "",
        messages: [{ role: "user", content: "Test" }],
        stream: false,
      };

      const response = await client.chat(request, false);
      expect(attemptCount).toBe(2);
      expect(response.content).toBe("Review findings here.");
    });

    it("retries on 403 with rate limit headers (secondary limits)", async () => {
      let attemptCount = 0;
      server.use(
        http.post("https://api.githubcopilot.com/chat/completions", () => {
          attemptCount++;
          if (attemptCount === 1) {
            return new HttpResponse(null, {
              status: 403,
              headers: {
                "x-ratelimit-remaining": "5",
                "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 1), // 1 second in future
              },
            });
          }
          return HttpResponse.json(chatCompletionsFixture);
        })
      );

      const client = new CopilotClient(authProvider);
      const request: ChatRequest = {
        model: "gpt-4",
        systemPrompt: "",
        messages: [{ role: "user", content: "Test" }],
        stream: false,
      };

      const response = await client.chat(request, false);
      expect(attemptCount).toBe(2);
      expect(response.content).toBe("Review findings here.");
    });

    it("max 2 retries then throws", async () => {
      let attemptCount = 0;
      server.use(
        http.post("https://api.githubcopilot.com/chat/completions", () => {
          attemptCount++;
          return new HttpResponse(null, { status: 502 });
        })
      );

      const client = new CopilotClient(authProvider);
      const request: ChatRequest = {
        model: "gpt-4",
        systemPrompt: "",
        messages: [{ role: "user", content: "Test" }],
        stream: false,
      };

      await expect(client.chat(request, false)).rejects.toThrow(ClientError);
      expect(attemptCount).toBe(3); // Initial + 2 retries
    });

    it("does not retry on 401 with authorize_url (code: model_auth)", async () => {
      let attemptCount = 0;
      server.use(
        http.post("https://api.githubcopilot.com/chat/completions", () => {
          attemptCount++;
          return HttpResponse.json(
            { error: { message: "Unauthorized", authorize_url: "https://github.com/login" } },
            { status: 401 }
          );
        })
      );

      const client = new CopilotClient(authProvider);
      const request: ChatRequest = {
        model: "gpt-4",
        systemPrompt: "",
        messages: [{ role: "user", content: "Test" }],
        stream: false,
      };

      try {
        await client.chat(request, false);
        expect.fail("Expected error to be thrown");
      } catch (error: any) {
        expect(attemptCount).toBe(1); // No retry
        expect(error.code).toBe("model_auth");
        expect(error.authorizeUrl).toBe("https://github.com/login");
      }
    });

    it("does not retry on 401 WITHOUT authorize_url (code: request_failed)", async () => {
      let attemptCount = 0;
      server.use(
        http.post("https://api.githubcopilot.com/chat/completions", () => {
          attemptCount++;
          return HttpResponse.json(
            { error: { message: "Unauthorized" } },
            { status: 401 }
          );
        })
      );

      const client = new CopilotClient(authProvider);
      const request: ChatRequest = {
        model: "gpt-4",
        systemPrompt: "",
        messages: [{ role: "user", content: "Test" }],
        stream: false,
      };

      try {
        await client.chat(request, false);
        expect.fail("Expected error to be thrown");
      } catch (error: any) {
        expect(attemptCount).toBe(1); // No retry
        expect(error.code).toBe("request_failed");
        expect(error.authorizeUrl).toBeUndefined();
      }
    });

    it("does not retry on other non-2xx", async () => {
      let attemptCount = 0;
      server.use(
        http.post("https://api.githubcopilot.com/chat/completions", () => {
          attemptCount++;
          return HttpResponse.json({ error: { message: "Bad request" } }, { status: 400 });
        })
      );

      const client = new CopilotClient(authProvider);
      const request: ChatRequest = {
        model: "gpt-4",
        systemPrompt: "",
        messages: [{ role: "user", content: "Test" }],
        stream: false,
      };

      await expect(client.chat(request, false)).rejects.toThrow(ClientError);
      expect(attemptCount).toBe(1); // No retry
    });

    it("assigns correct error codes for different status codes", async () => {
      const testCases = [
        { status: 429, expectedCode: "rate_limited", shouldRetry: true },
        { status: 502, expectedCode: "server_error", shouldRetry: true },
        { status: 503, expectedCode: "server_error", shouldRetry: true },
        { status: 504, expectedCode: "server_error", shouldRetry: true },
        { status: 400, expectedCode: "request_failed", shouldRetry: false },
      ];

      for (const { status, expectedCode, shouldRetry } of testCases) {
        let attemptCount = 0;
        server.use(
          http.post("https://api.githubcopilot.com/chat/completions", () => {
            attemptCount++;
            if (shouldRetry && attemptCount === 1) {
              return HttpResponse.json({ error: { message: `Error ${status}` } }, { status });
            }
            if (!shouldRetry) {
              return HttpResponse.json({ error: { message: `Error ${status}` } }, { status });
            }
            return HttpResponse.json(chatCompletionsFixture);
          })
        );

        const client = new CopilotClient(authProvider);
        const request: ChatRequest = {
          model: "gpt-4",
          systemPrompt: "",
          messages: [{ role: "user", content: "Test" }],
          stream: false,
        };

        try {
          await client.chat(request, false);
          if (!shouldRetry) {
            expect.fail(`Expected error to be thrown for status ${status}`);
          }
        } catch (error: any) {
          if (shouldRetry) {
            expect.fail(`Should have succeeded after retry for status ${status}`);
          }
          expect(error.code).toBe(expectedCode);
        }
      }
    });
  });

  describe("response validation", () => {
    it("throws invalid_response on missing choices[0]", async () => {
      server.use(
        http.post("https://api.githubcopilot.com/chat/completions", () => {
          return HttpResponse.json({ choices: [] });
        })
      );

      const client = new CopilotClient(authProvider);
      const request: ChatRequest = {
        model: "gpt-4",
        systemPrompt: "",
        messages: [{ role: "user", content: "Test" }],
        stream: false,
      };

      try {
        await client.chat(request, false);
        expect.fail("Expected error to be thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ClientError);
        expect((error as ClientError).code).toBe("invalid_response");
      }
    });

    it("throws invalid_response on unexpected response shape", async () => {
      server.use(
        http.post("https://api.githubcopilot.com/chat/completions", () => {
          return HttpResponse.json({ unexpected: "format" });
        })
      );

      const client = new CopilotClient(authProvider);
      const request: ChatRequest = {
        model: "gpt-4",
        systemPrompt: "",
        messages: [{ role: "user", content: "Test" }],
        stream: false,
      };

      await expect(client.chat(request, false)).rejects.toThrow(ClientError);
    });
  });
});
