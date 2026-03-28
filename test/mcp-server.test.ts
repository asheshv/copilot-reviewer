// test/mcp-server.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  CopilotReviewError,
  AuthError,
  DiffError,
  ParameterError,
} from "../src/lib/types.js";
import type { ReviewResult, ModelInfo, ChatResponse } from "../src/lib/types.js";

// Shared mock instances for client and model manager
const mockChat = vi.fn();
const mockChatStream = vi.fn();
const mockListModels = vi.fn();
const mockAutoSelect = vi.fn();
const mockValidateModel = vi.fn();

// Mock all lib dependencies before importing the module under test
vi.mock("../src/lib/review.js", () => ({
  review: vi.fn(),
}));

vi.mock("../src/lib/config.js", () => ({
  loadConfig: vi.fn(),
}));

vi.mock("../src/lib/auth.js", () => ({
  createDefaultAuthProvider: vi.fn(() => ({
    getAuthenticatedHeaders: vi.fn().mockResolvedValue({ Authorization: "token test" }),
  })),
}));

vi.mock("../src/lib/client.js", () => ({
  CopilotClient: vi.fn().mockImplementation(() => ({
    chat: mockChat,
    chatStream: mockChatStream,
  })),
}));

vi.mock("../src/lib/models.js", () => ({
  ModelManager: vi.fn().mockImplementation(() => ({
    listModels: mockListModels,
    autoSelect: mockAutoSelect,
    validateModel: mockValidateModel,
  })),
}));

import { review as mockReview } from "../src/lib/review.js";
import { loadConfig as mockLoadConfig } from "../src/lib/config.js";
import {
  createMcpServer,
  handleReview,
  handleChat,
  handleModels,
  VALID_MODES,
  validateReviewParams,
  _resetState,
} from "../src/mcp-server.js";

describe("MCP Server", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetState(); // Reset singletons so fresh mocks are picked up
  });

  describe("createMcpServer()", () => {
    it("returns a McpServer instance", () => {
      const server = createMcpServer();
      expect(server).toBeDefined();
      expect(server.server).toBeDefined();
    });

    it("registers copilot_review tool", () => {
      const server = createMcpServer();
      const tools = (server as any)._registeredTools;
      expect("copilot_review" in tools).toBe(true);
    });

    it("registers copilot_chat tool", () => {
      const server = createMcpServer();
      const tools = (server as any)._registeredTools;
      expect("copilot_chat" in tools).toBe(true);
    });

    it("registers copilot_models tool", () => {
      const server = createMcpServer();
      const tools = (server as any)._registeredTools;
      expect("copilot_models" in tools).toBe(true);
    });
  });

  describe("validateReviewParams()", () => {
    it("rejects invalid mode with invalid_parameter error", () => {
      expect(() => validateReviewParams({ mode: "invalid" })).toThrow(ParameterError);
      try {
        validateReviewParams({ mode: "invalid" });
      } catch (err) {
        expect((err as ParameterError).code).toBe("invalid_parameter");
        expect((err as ParameterError).message).toContain("Invalid mode 'invalid'");
        expect((err as ParameterError).message).toContain("Valid:");
      }
    });

    it("rejects pr mode without pr param with missing_parameter error", () => {
      expect(() => validateReviewParams({ mode: "pr" })).toThrow(ParameterError);
      try {
        validateReviewParams({ mode: "pr" });
      } catch (err) {
        expect((err as ParameterError).code).toBe("missing_parameter");
        expect((err as ParameterError).message).toContain("requires 'pr' parameter");
      }
    });

    it("rejects range mode without range param", () => {
      expect(() => validateReviewParams({ mode: "range" })).toThrow(ParameterError);
      try {
        validateReviewParams({ mode: "range" });
      } catch (err) {
        expect((err as ParameterError).code).toBe("missing_parameter");
        expect((err as ParameterError).message).toContain("requires 'range' parameter");
      }
    });

    it("rejects commits mode without count param", () => {
      expect(() => validateReviewParams({ mode: "commits" })).toThrow(ParameterError);
      try {
        validateReviewParams({ mode: "commits" });
      } catch (err) {
        expect((err as ParameterError).code).toBe("missing_parameter");
        expect((err as ParameterError).message).toContain("requires 'count' parameter");
      }
    });

    it("accepts valid modes without mode-specific params when not required", () => {
      expect(() => validateReviewParams({ mode: "unstaged" })).not.toThrow();
      expect(() => validateReviewParams({ mode: "staged" })).not.toThrow();
      expect(() => validateReviewParams({ mode: "local" })).not.toThrow();
      expect(() => validateReviewParams({ mode: "branch" })).not.toThrow();
    });

    it("accepts pr mode with pr param", () => {
      expect(() => validateReviewParams({ mode: "pr", pr: 42 })).not.toThrow();
    });

    it("accepts range mode with range param", () => {
      expect(() => validateReviewParams({ mode: "range", range: "abc..def" })).not.toThrow();
    });

    it("accepts commits mode with count param", () => {
      expect(() => validateReviewParams({ mode: "commits", count: 5 })).not.toThrow();
    });
  });

  describe("handleReview()", () => {
    const mockConfig = {
      model: "gpt-4.1",
      format: "markdown" as const,
      stream: false,
      prompt: "Review code",
      defaultBase: "main",
      ignorePaths: [],
    };

    const mockReviewResult: ReviewResult = {
      content: "### Review\nLooks good",
      model: "gpt-4.1",
      usage: { totalTokens: 500 },
      diff: {
        raw: "diff content",
        files: [{ path: "src/foo.ts", status: "modified", insertions: 10, deletions: 2 }],
        stats: { filesChanged: 1, insertions: 10, deletions: 2 },
      },
      warnings: [],
    };

    beforeEach(() => {
      (mockLoadConfig as ReturnType<typeof vi.fn>).mockResolvedValue(mockConfig);
      (mockReview as ReturnType<typeof vi.fn>).mockResolvedValue(mockReviewResult);
    });

    it("returns structured result on success with content, model, usage, diff, warnings", async () => {
      const result = await handleReview({ mode: "staged" });

      expect(result.isError).toBeUndefined();
      expect(result.content).toHaveLength(2);
      expect(result.content[0].type).toBe("text");

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.content).toBe("### Review\nLooks good");
      expect(parsed.model).toBe("gpt-4.1");
      expect(parsed.usage).toEqual({ totalTokens: 500 });
      expect(parsed.diff.filesChanged).toBe(1);
      expect(parsed.diff.insertions).toBe(10);
      expect(parsed.diff.deletions).toBe(2);
      expect(parsed.diff.files).toEqual([{ path: "src/foo.ts", status: "modified" }]);
      expect(parsed.warnings).toEqual([]);

      // Second content block: human-readable usage summary
      expect(result.content[1].type).toBe("text");
      expect(result.content[1].text).toContain("Token usage: 500 tokens");
      expect(result.content[1].text).toContain("Model: gpt-4.1");
      expect(result.content[1].text).toContain("Files reviewed: 1");
    });

    it("maps tool parameters to ReviewOptions correctly", async () => {
      await handleReview({ mode: "pr", pr: 42, model: "gpt-4.1", prompt: "custom" });

      expect(mockLoadConfig).toHaveBeenCalledWith({ prompt: "custom", model: "gpt-4.1" });
      expect(mockReview).toHaveBeenCalledWith(
        expect.objectContaining({
          diff: expect.objectContaining({
            mode: "pr",
            pr: 42,
            ignorePaths: [],
          }),
          config: mockConfig,
          model: "gpt-4.1",
        }),
        expect.anything(), // client
        expect.anything(), // models
      );
    });

    it("returns structured error with isError true on auth failure", async () => {
      const authErr = new AuthError("no_token", "No GitHub token found.", false);
      (mockReview as ReturnType<typeof vi.fn>).mockRejectedValue(authErr);

      const result = await handleReview({ mode: "staged" });

      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe("no_token");
      expect(parsed.message).toBe("No GitHub token found.");
      expect(parsed.recoverable).toBe(false);
    });

    it("returns structured error with isError true on diff failure", async () => {
      const diffErr = new DiffError("no_repository", "Not a git repository.", false);
      (mockReview as ReturnType<typeof vi.fn>).mockRejectedValue(diffErr);

      const result = await handleReview({ mode: "staged" });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe("no_repository");
    });

    it("returns structured error for parameter validation failures", async () => {
      const result = await handleReview({ mode: "invalid" });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe("invalid_parameter");
    });

    it("returns structured error for unexpected non-CopilotReviewError", async () => {
      (mockReview as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("unexpected"));

      const result = await handleReview({ mode: "staged" });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe("unknown_error");
      expect(parsed.message).toBe("unexpected");
      expect(parsed.recoverable).toBe(false);
    });
  });

  describe("handleChat()", () => {
    const mockModelInfo: ModelInfo = {
      id: "gpt-4.1",
      name: "GPT 4.1",
      endpoints: ["/chat/completions"],
      streaming: true,
      toolCalls: false,
      maxPromptTokens: 128000,
      maxOutputTokens: 16384,
      tokenizer: "cl100k_base",
    };

    const mockChatResponse: ChatResponse = {
      content: "Here is my answer.",
      model: "gpt-4.1",
      usage: { totalTokens: 200 },
    };

    beforeEach(() => {
      mockAutoSelect.mockResolvedValue("gpt-4.1");
      mockValidateModel.mockResolvedValue(mockModelInfo);
      mockChat.mockResolvedValue(mockChatResponse);
    });

    it("calls client.chat with empty systemPrompt when no context", async () => {
      const result = await handleChat({ message: "What is this code?" });

      expect(result.isError).toBeUndefined();
      expect(mockChat).toHaveBeenCalledWith(
        expect.objectContaining({
          systemPrompt: "",
          messages: [{ role: "user", content: "What is this code?" }],
          stream: false,
        }),
        false, // useResponsesApi — /chat/completions only
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.content).toBe("Here is my answer.");
      expect(parsed.model).toBe("gpt-4.1");
      expect(parsed.usage).toEqual({ totalTokens: 200 });
    });

    it("uses context as systemPrompt when provided", async () => {
      const result = await handleChat({ message: "Review this", context: "function foo() {}" });

      expect(result.isError).toBeUndefined();
      expect(mockChat).toHaveBeenCalledWith(
        expect.objectContaining({
          systemPrompt: "function foo() {}",
        }),
        false,
      );
    });

    it("returns content, model, usage", async () => {
      const result = await handleChat({ message: "Hello" });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveProperty("content");
      expect(parsed).toHaveProperty("model");
      expect(parsed).toHaveProperty("usage");
    });

    it("uses explicit model override when provided", async () => {
      await handleChat({ message: "Hello", model: "claude-sonnet-4" });

      expect(mockValidateModel).toHaveBeenCalledWith("claude-sonnet-4");
      expect(mockAutoSelect).not.toHaveBeenCalled();
    });

    it("uses autoSelect when no model override", async () => {
      await handleChat({ message: "Hello" });

      expect(mockAutoSelect).toHaveBeenCalled();
    });

    it("returns structured error on CopilotReviewError", async () => {
      mockAutoSelect.mockRejectedValue(new AuthError("no_token", "No token", false));

      const result = await handleChat({ message: "Hello" });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe("no_token");
    });

    it("returns structured error on unexpected error", async () => {
      mockChat.mockRejectedValue(new Error("network down"));

      const result = await handleChat({ message: "Hello" });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe("unknown_error");
    });
  });

  describe("handleModels()", () => {
    const mockModelList: ModelInfo[] = [
      {
        id: "gpt-4.1",
        name: "GPT 4.1",
        endpoints: ["/chat/completions", "/responses"],
        streaming: true,
        toolCalls: true,
        maxPromptTokens: 128000,
        maxOutputTokens: 16384,
        tokenizer: "cl100k_base",
      },
      {
        id: "claude-sonnet-4",
        name: "Claude Sonnet 4",
        endpoints: ["/chat/completions"],
        streaming: true,
        toolCalls: false,
        maxPromptTokens: 200000,
        maxOutputTokens: 8192,
        tokenizer: "claude",
      },
    ];

    it("returns model list with id, name, endpoints, capabilities", async () => {
      mockListModels.mockResolvedValue(mockModelList);

      const result = await handleModels();

      expect(result.isError).toBeUndefined();
      expect(result.content).toHaveLength(1);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.models).toHaveLength(2);
      expect(parsed.models[0]).toEqual({
        id: "gpt-4.1",
        name: "GPT 4.1",
        endpoints: ["/chat/completions", "/responses"],
        streaming: true,
        toolCalls: true,
        maxPromptTokens: 128000,
        maxOutputTokens: 16384,
      });
      // tokenizer should be excluded from MCP response
      expect(parsed.models[0].tokenizer).toBeUndefined();
    });

    it("returns structured error on failure", async () => {
      mockListModels.mockRejectedValue(new AuthError("no_token", "Auth required", false));

      const result = await handleModels();

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe("no_token");
    });

    it("returns structured error on unexpected failure", async () => {
      mockListModels.mockRejectedValue(new Error("network"));

      const result = await handleModels();

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe("unknown_error");
    });
  });

  describe("resilience", () => {
    beforeEach(() => {
      (mockLoadConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
        model: "auto",
        format: "markdown",
        stream: false,
        prompt: "",
        defaultBase: "main",
        ignorePaths: [],
      });
    });

    it("handleReview never throws — returns error result instead", async () => {
      (mockReview as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));

      const result = await handleReview({ mode: "staged" });
      expect(result.isError).toBe(true);
    });

    it("handleChat never throws — returns error result instead", async () => {
      mockAutoSelect.mockRejectedValue(new Error("boom"));

      const result = await handleChat({ message: "test" });
      expect(result.isError).toBe(true);
    });

    it("handleModels never throws — returns error result instead", async () => {
      mockListModels.mockRejectedValue(new Error("boom"));

      const result = await handleModels();
      expect(result.isError).toBe(true);
    });

    it("handles sequential calls without state leakage", async () => {
      // First call fails
      (mockReview as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("fail1"));
      const result1 = await handleReview({ mode: "staged" });
      expect(result1.isError).toBe(true);

      // Second call succeeds
      (mockReview as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        content: "OK",
        model: "gpt-4.1",
        usage: { totalTokens: 10 },
        diff: { raw: "", files: [], stats: { filesChanged: 0, insertions: 0, deletions: 0 } },
        warnings: [],
      });
      const result2 = await handleReview({ mode: "staged" });
      expect(result2.isError).toBeUndefined();
    });
  });

  describe("VALID_MODES", () => {
    it("contains all 7 valid modes", () => {
      expect(VALID_MODES).toEqual([
        "unstaged", "staged", "local", "branch", "pr", "commits", "range",
      ]);
    });
  });
});
