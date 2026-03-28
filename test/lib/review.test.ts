// test/lib/review.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { review, reviewStream } from "../../src/lib/review.js";
import type {
  ReviewOptions,
  DiffResult,
  ChatResponse,
  ModelInfo,
  StreamChunk,
  ResolvedConfig,
} from "../../src/lib/types.js";
import { DiffError, ReviewError } from "../../src/lib/types.js";

// Mock all dependencies
vi.mock("../../src/lib/diff.js", () => ({
  collectDiff: vi.fn(),
}));

vi.mock("../../src/lib/prompt.js", () => ({
  assembleUserMessage: vi.fn((diff) => `Review the following changes.\n\n## Summary\nFiles changed: ${diff.stats.filesChanged}\nInsertions: +${diff.stats.insertions}, Deletions: -${diff.stats.deletions}\n\n## Diff\n\`\`\`diff\n${diff.raw}\n\`\`\``),
}));

vi.mock("../../src/lib/formatter.js", () => ({
  format: vi.fn((result, fmt) => `formatted:${fmt}:${result.content}`),
  detectHighSeverity: vi.fn(() => false),
}));

import { collectDiff } from "../../src/lib/diff.js";
import { assembleUserMessage } from "../../src/lib/prompt.js";
import { format } from "../../src/lib/formatter.js";

describe("review()", () => {
  const mockDiffResult: DiffResult = {
    raw: "diff --git a/test.ts b/test.ts\n+added line",
    files: [{ path: "test.ts", status: "modified", insertions: 1, deletions: 0 }],
    stats: { filesChanged: 1, insertions: 1, deletions: 0 },
  };

  const mockConfig: ResolvedConfig = {
    model: "gpt-4.1",
    format: "markdown",
    stream: false,
    prompt: "You are a code reviewer.",
    defaultBase: "main",
    ignorePaths: [],
  };

  const mockModelInfo: ModelInfo = {
    id: "gpt-4.1",
    name: "GPT-4.1",
    endpoints: ["/chat/completions"],
    streaming: true,
    toolCalls: false,
    maxPromptTokens: 8000,
    maxOutputTokens: 4000,
    tokenizer: "cl100k_base",
  };

  const mockChatResponse: ChatResponse = {
    content: "### HIGH Security issue found",
    model: "gpt-4.1",
    usage: { totalTokens: 123 },
  };

  let mockClient: any;
  let mockModels: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock client
    mockClient = {
      chat: vi.fn().mockResolvedValue(mockChatResponse),
      chatStream: vi.fn(),
    };

    // Mock models
    mockModels = {
      autoSelect: vi.fn().mockResolvedValue("gpt-4.1"),
      validateModel: vi.fn().mockResolvedValue(mockModelInfo),
    };

    // Setup default mocks
    vi.mocked(collectDiff).mockResolvedValue(mockDiffResult);
  });

  it("executes full pipeline: diff -> model -> budget -> assemble -> call -> format", async () => {
    const options: ReviewOptions = {
      diff: { mode: "unstaged" },
      config: mockConfig,
      model: "gpt-4.1",
    };

    const result = await review(options, mockClient, mockModels);

    // Verify pipeline steps
    expect(collectDiff).toHaveBeenCalledWith(expect.objectContaining({ mode: "unstaged", ignorePaths: mockConfig.ignorePaths }));
    expect(mockModels.validateModel).toHaveBeenCalledWith("gpt-4.1");
    expect(assembleUserMessage).toHaveBeenCalledWith(mockDiffResult);
    expect(mockClient.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-4.1",
        systemPrompt: "You are a code reviewer.",
        messages: expect.any(Array),
        stream: false,
      }),
      false // useResponsesApi
    );
    expect(format).toHaveBeenCalledWith(
      expect.objectContaining({
        content: mockChatResponse.content,
        model: mockChatResponse.model,
        usage: mockChatResponse.usage,
      }),
      "markdown"
    );

    expect(result.model).toBe("gpt-4.1");
    expect(result.diff).toEqual(mockDiffResult);
  });

  it("returns ReviewResult with content, model, usage, diff, warnings", async () => {
    const options: ReviewOptions = {
      diff: { mode: "staged" },
      config: mockConfig,
      model: "gpt-4.1",
    };

    const result = await review(options, mockClient, mockModels);

    expect(result).toHaveProperty("content");
    expect(result).toHaveProperty("model");
    expect(result).toHaveProperty("usage");
    expect(result).toHaveProperty("diff");
    expect(result).toHaveProperty("warnings");
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  describe("empty diff", () => {
    it("returns early with no-changes result without calling API", async () => {
      vi.mocked(collectDiff).mockRejectedValue(
        new DiffError("empty_diff", "No changes found for mode 'unstaged'.", false)
      );

      const options: ReviewOptions = {
        diff: { mode: "unstaged" },
        config: mockConfig,
      };

      const result = await review(options, mockClient, mockModels);

      expect(result.content).toBe("No changes found.");
      expect(result.model).toBe("none");
      expect(result.usage.totalTokens).toBe(0);
      expect(result.warnings).toHaveLength(0);

      // API should not be called
      expect(mockClient.chat).not.toHaveBeenCalled();
      expect(mockModels.autoSelect).not.toHaveBeenCalled();
      expect(mockModels.validateModel).not.toHaveBeenCalled();
    });
  });

  describe("model resolution", () => {
    it("auto mode: calls autoSelect() then validateModel() to get ModelInfo", async () => {
      const options: ReviewOptions = {
        diff: { mode: "unstaged" },
        config: { ...mockConfig, model: "auto" },
        model: "auto",
      };

      await review(options, mockClient, mockModels);

      expect(mockModels.autoSelect).toHaveBeenCalled();
      expect(mockModels.validateModel).toHaveBeenCalledWith("gpt-4.1");
    });

    it("explicit mode: calls validateModel() directly", async () => {
      const options: ReviewOptions = {
        diff: { mode: "unstaged" },
        config: mockConfig,
        model: "claude-sonnet",
      };

      mockModels.validateModel.mockResolvedValue({
        ...mockModelInfo,
        id: "claude-sonnet",
      });

      await review(options, mockClient, mockModels);

      expect(mockModels.autoSelect).not.toHaveBeenCalled();
      expect(mockModels.validateModel).toHaveBeenCalledWith("claude-sonnet");
    });

    it("uses config.model when no explicit model provided", async () => {
      const options: ReviewOptions = {
        diff: { mode: "unstaged" },
        config: { ...mockConfig, model: "gpt-4.1" },
      };

      await review(options, mockClient, mockModels);

      expect(mockModels.validateModel).toHaveBeenCalledWith("gpt-4.1");
    });
  });

  describe("token budget", () => {
    it("estimate < 80% of maxPromptTokens: no warning", async () => {
      // Small diff: ~50 chars system + 100 chars diff = 150 chars / 4 = 37.5 tokens
      // 37.5 / 8000 = 0.47% (way under 80%)
      const smallDiff: DiffResult = {
        raw: "diff --git a/test.ts b/test.ts\n+small change",
        files: [{ path: "test.ts", status: "modified", insertions: 1, deletions: 0 }],
        stats: { filesChanged: 1, insertions: 1, deletions: 0 },
      };
      vi.mocked(collectDiff).mockResolvedValue(smallDiff);

      const options: ReviewOptions = {
        diff: { mode: "unstaged" },
        config: mockConfig,
        model: "gpt-4.1",
      };

      const result = await review(options, mockClient, mockModels);

      expect(result.warnings).toHaveLength(0);
    });

    it("estimate >= 80% and < 100%: adds warning to result", async () => {
      // Create a large diff that's 80%+ of maxPromptTokens (8000)
      // Need: 8000 * 0.85 = 6800 tokens * 4 chars/token = 27200 chars
      const largeDiff: DiffResult = {
        raw: "x".repeat(25000), // 25000 chars diff
        files: [{ path: "test.ts", status: "modified", insertions: 100, deletions: 50 }],
        stats: { filesChanged: 1, insertions: 100, deletions: 50 },
      };
      vi.mocked(collectDiff).mockResolvedValue(largeDiff);

      const options: ReviewOptions = {
        diff: { mode: "unstaged" },
        config: { ...mockConfig, prompt: "x".repeat(2000) }, // 2000 char prompt
        model: "gpt-4.1",
      };

      const result = await review(options, mockClient, mockModels);

      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain("Token budget");
    });

    it("estimate >= 100%: throws ReviewError diff_too_large", async () => {
      // Create a huge diff that exceeds maxPromptTokens
      // Need: 8000 * 1.05 = 8400 tokens * 4 chars/token = 33600 chars
      const hugeDiff: DiffResult = {
        raw: "x".repeat(33000),
        files: [{ path: "test.ts", status: "modified", insertions: 1000, deletions: 500 }],
        stats: { filesChanged: 1, insertions: 1000, deletions: 500 },
      };
      vi.mocked(collectDiff).mockResolvedValue(hugeDiff);

      const options: ReviewOptions = {
        diff: { mode: "unstaged" },
        config: { ...mockConfig, prompt: "x".repeat(1000) },
        model: "gpt-4.1",
      };

      const err = await review(options, mockClient, mockModels).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ReviewError);
      expect((err as ReviewError).code).toBe("diff_too_large");
      expect((err as ReviewError).suggestion).toBe("Use ignorePaths or a larger-context model");

      // API should not be called
      expect(mockClient.chat).not.toHaveBeenCalled();
    });
  });

  describe("message assembly", () => {
    it("system message is config.prompt (single concatenated string)", async () => {
      const options: ReviewOptions = {
        diff: { mode: "unstaged" },
        config: { ...mockConfig, prompt: "Custom system prompt." },
        model: "gpt-4.1",
      };

      await review(options, mockClient, mockModels);

      expect(mockClient.chat).toHaveBeenCalledWith(
        expect.objectContaining({
          systemPrompt: "Custom system prompt.",
        }),
        expect.any(Boolean)
      );
    });

    it("user message formatted via assembleUserMessage()", async () => {
      const options: ReviewOptions = {
        diff: { mode: "unstaged" },
        config: mockConfig,
        model: "gpt-4.1",
      };

      await review(options, mockClient, mockModels);

      expect(assembleUserMessage).toHaveBeenCalledWith(mockDiffResult);
      expect(mockClient.chat).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: "user",
              content: expect.stringContaining("Review the following changes"),
            },
          ],
        }),
        expect.any(Boolean)
      );
    });
  });

  describe("ignorePaths", () => {
    it("passes config.ignorePaths to DiffOptions", async () => {
      const options: ReviewOptions = {
        diff: { mode: "unstaged" },
        config: { ...mockConfig, ignorePaths: ["*.test.ts", "node_modules/**"] },
        model: "gpt-4.1",
      };

      await review(options, mockClient, mockModels);

      expect(collectDiff).toHaveBeenCalledWith(
        expect.objectContaining({
          ignorePaths: ["*.test.ts", "node_modules/**"],
        })
      );
    });
  });

  describe("endpoint routing (useResponsesApi)", () => {
    it("uses Responses API when model endpoints include /responses", async () => {
      const responsesModel: ModelInfo = {
        ...mockModelInfo,
        endpoints: ["/responses"],
      };
      mockModels.validateModel.mockResolvedValue(responsesModel);

      const options: ReviewOptions = {
        diff: { mode: "unstaged" },
        config: mockConfig,
        model: "claude-sonnet",
      };

      await review(options, mockClient, mockModels);

      expect(mockClient.chat).toHaveBeenCalledWith(
        expect.any(Object),
        true // useResponsesApi = true
      );
    });

    it("uses Chat Completions API when model endpoints do not include /responses", async () => {
      const chatModel: ModelInfo = {
        ...mockModelInfo,
        endpoints: ["/chat/completions"],
      };
      mockModels.validateModel.mockResolvedValue(chatModel);

      const options: ReviewOptions = {
        diff: { mode: "unstaged" },
        config: mockConfig,
        model: "gpt-4.1",
      };

      await review(options, mockClient, mockModels);

      expect(mockClient.chat).toHaveBeenCalledWith(
        expect.any(Object),
        false // useResponsesApi = false
      );
    });
  });

  describe("empty response", () => {
    it("returns exit code 0 with 'no findings' warning", async () => {
      mockClient.chat.mockResolvedValue({
        content: "",
        model: "gpt-4.1",
        usage: { totalTokens: 50 },
      });

      const options: ReviewOptions = {
        diff: { mode: "unstaged" },
        config: mockConfig,
        model: "gpt-4.1",
      };

      const result = await review(options, mockClient, mockModels);

      // Content should be formatted (not raw empty string) — formatter adds structure
      expect(result.content).toBeTruthy();
      expect(result.warnings).toContain("Copilot returned no findings.");
    });
  });
});

describe("reviewStream()", () => {
  const mockDiffResult: DiffResult = {
    raw: "diff --git a/test.ts b/test.ts\n+added line",
    files: [{ path: "test.ts", status: "modified", insertions: 1, deletions: 0 }],
    stats: { filesChanged: 1, insertions: 1, deletions: 0 },
  };

  const mockConfig: ResolvedConfig = {
    model: "gpt-4.1",
    format: "markdown",
    stream: true,
    prompt: "You are a code reviewer.",
    defaultBase: "main",
    ignorePaths: [],
  };

  const mockModelInfo: ModelInfo = {
    id: "gpt-4.1",
    name: "GPT-4.1",
    endpoints: ["/chat/completions"],
    streaming: true,
    toolCalls: false,
    maxPromptTokens: 8000,
    maxOutputTokens: 4000,
    tokenizer: "cl100k_base",
  };

  let mockClient: any;
  let mockModels: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock client
    mockClient = {
      chat: vi.fn(),
      chatStream: vi.fn(),
    };

    // Mock models
    mockModels = {
      autoSelect: vi.fn().mockResolvedValue("gpt-4.1"),
      validateModel: vi.fn().mockResolvedValue(mockModelInfo),
    };

    // Setup default mocks
    vi.mocked(collectDiff).mockResolvedValue(mockDiffResult);
  });

  it("returns tuple { stream, warnings, diff, model }", async () => {
    async function* mockStream() {
      yield { type: "content", text: "Finding 1" } as StreamChunk;
      yield { type: "content", text: "Finding 2" } as StreamChunk;
      yield { type: "done", usage: { totalTokens: 100 }, model: "gpt-4.1" } as StreamChunk;
    }

    mockClient.chatStream.mockReturnValue(mockStream());

    const options: ReviewOptions = {
      diff: { mode: "unstaged" },
      config: mockConfig,
      model: "gpt-4.1",
    };

    const result = await reviewStream(options, mockClient, mockModels);

    expect(result).toHaveProperty("stream");
    expect(result).toHaveProperty("warnings");
    expect(result).toHaveProperty("diff");
    expect(result).toHaveProperty("model");
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(result.diff).toEqual(mockDiffResult);
    expect(result.model).toBe("gpt-4.1");
  });

  it("warnings computed before stream starts", async () => {
    // Create a large diff to trigger warning
    const largeDiff: DiffResult = {
      raw: "x".repeat(25000),
      files: [{ path: "test.ts", status: "modified", insertions: 100, deletions: 50 }],
      stats: { filesChanged: 1, insertions: 100, deletions: 50 },
    };
    vi.mocked(collectDiff).mockResolvedValue(largeDiff);

    async function* mockStream() {
      yield { type: "content", text: "Finding 1" } as StreamChunk;
    }

    mockClient.chatStream.mockReturnValue(mockStream());

    const options: ReviewOptions = {
      diff: { mode: "unstaged" },
      config: { ...mockConfig, prompt: "x".repeat(2000) },
      model: "gpt-4.1",
    };

    const result = await reviewStream(options, mockClient, mockModels);

    // Warnings should be available immediately (before consuming stream)
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("Token budget");
  });

  it("stream yields string chunks from client.chatStream()", async () => {
    async function* mockStream() {
      yield { type: "content", text: "Part 1" } as StreamChunk;
      yield { type: "content", text: "Part 2" } as StreamChunk;
      yield { type: "content", text: "Part 3" } as StreamChunk;
      yield { type: "done", usage: { totalTokens: 123 }, model: "gpt-4.1" } as StreamChunk;
    }

    mockClient.chatStream.mockReturnValue(mockStream());

    const options: ReviewOptions = {
      diff: { mode: "unstaged" },
      config: mockConfig,
      model: "gpt-4.1",
    };

    const result = await reviewStream(options, mockClient, mockModels);

    const chunks: string[] = [];
    for await (const chunk of result.stream) {
      chunks.push(chunk);
    }

    // Should only yield text strings (not StreamChunk objects)
    expect(chunks).toEqual(["Part 1", "Part 2", "Part 3"]);
  });

  it("model is resolved model ID", async () => {
    async function* mockStream() {
      yield { type: "content", text: "Finding" } as StreamChunk;
    }

    mockClient.chatStream.mockReturnValue(mockStream());

    const options: ReviewOptions = {
      diff: { mode: "unstaged" },
      config: mockConfig,
      model: "claude-sonnet",
    };

    mockModels.validateModel.mockResolvedValue({
      ...mockModelInfo,
      id: "claude-sonnet",
    });

    const result = await reviewStream(options, mockClient, mockModels);

    expect(result.model).toBe("claude-sonnet");
  });

  it("diff is DiffResult metadata", async () => {
    async function* mockStream() {
      yield { type: "content", text: "Finding" } as StreamChunk;
    }

    mockClient.chatStream.mockReturnValue(mockStream());

    const options: ReviewOptions = {
      diff: { mode: "staged" },
      config: mockConfig,
      model: "gpt-4.1",
    };

    const result = await reviewStream(options, mockClient, mockModels);

    expect(result.diff).toEqual(mockDiffResult);
    expect(result.diff.stats.filesChanged).toBe(1);
  });

  it("handles empty diff by throwing before streaming", async () => {
    vi.mocked(collectDiff).mockRejectedValue(
      new DiffError("empty_diff", "No changes found for mode 'unstaged'.", false)
    );

    const options: ReviewOptions = {
      diff: { mode: "unstaged" },
      config: mockConfig,
    };

    await expect(reviewStream(options, mockClient, mockModels)).rejects.toThrow(DiffError);
  });

  it("passes ignorePaths to collectDiff", async () => {
    async function* mockStream() {
      yield { type: "content", text: "Finding" } as StreamChunk;
    }

    mockClient.chatStream.mockReturnValue(mockStream());

    const options: ReviewOptions = {
      diff: { mode: "unstaged" },
      config: { ...mockConfig, ignorePaths: ["*.log", "dist/**"] },
      model: "gpt-4.1",
    };

    await reviewStream(options, mockClient, mockModels);

    expect(collectDiff).toHaveBeenCalledWith(
      expect.objectContaining({
        ignorePaths: ["*.log", "dist/**"],
      })
    );
  });

  it("captures usage from done chunk after stream is consumed", async () => {
    async function* mockStream() {
      yield { type: "content", text: "Finding" } as StreamChunk;
      yield { type: "done", usage: { totalTokens: 42 }, model: "gpt-4.1" } as StreamChunk;
    }

    mockClient.chatStream.mockReturnValue(mockStream());

    const options: ReviewOptions = {
      diff: { mode: "unstaged" },
      config: mockConfig,
      model: "gpt-4.1",
    };

    const result = await reviewStream(options, mockClient, mockModels);
    expect(result.usage).toBeUndefined(); // not yet consumed

    for await (const _ of result.stream) { /* drain */ }

    expect(result.usage).toEqual({ totalTokens: 42 });
  });

  it("usage remains undefined when done chunk has no usage", async () => {
    async function* mockStream() {
      yield { type: "content", text: "Finding" } as StreamChunk;
      yield { type: "done" } as StreamChunk;
    }

    mockClient.chatStream.mockReturnValue(mockStream());

    const options: ReviewOptions = {
      diff: { mode: "unstaged" },
      config: mockConfig,
      model: "gpt-4.1",
    };

    const result = await reviewStream(options, mockClient, mockModels);
    for await (const _ of result.stream) { /* drain */ }

    expect(result.usage).toBeUndefined();
  });

  it("uses Responses API when model supports it", async () => {
    const responsesModel: ModelInfo = {
      ...mockModelInfo,
      endpoints: ["/responses"],
    };
    mockModels.validateModel.mockResolvedValue(responsesModel);

    async function* mockStream() {
      yield { type: "content", text: "Finding" } as StreamChunk;
    }

    mockClient.chatStream.mockReturnValue(mockStream());

    const options: ReviewOptions = {
      diff: { mode: "unstaged" },
      config: mockConfig,
      model: "claude-sonnet",
    };

    await reviewStream(options, mockClient, mockModels);

    expect(mockClient.chatStream).toHaveBeenCalledWith(
      expect.any(Object),
      true // useResponsesApi = true
    );
  });
});
