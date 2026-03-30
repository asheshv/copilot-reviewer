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
  ChatRequest,
} from "../../src/lib/types.js";
import { DiffError, ReviewError } from "../../src/lib/types.js";
import type { ReviewProvider } from "../../src/lib/providers/types.js";

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

// ============================================================================
// MockProvider
// ============================================================================

const MOCK_MODEL_INFO: ModelInfo = {
  id: "mock-model",
  name: "Mock Model",
  endpoints: ["/chat/completions"],
  streaming: true,
  toolCalls: false,
  maxPromptTokens: 128000,
  maxOutputTokens: 4096,
  tokenizer: "cl100k_base",
};

function createMockProvider(overrides: {
  chatResponse?: ChatResponse;
  streamChunks?: StreamChunk[];
  hasAutoSelect?: boolean;
} = {}): ReviewProvider & { chatCalls: ChatRequest[] } {
  const chatResponse: ChatResponse = overrides.chatResponse ?? {
    content: "### HIGH Security issue found",
    model: "mock-model",
    usage: { totalTokens: 123 },
  };

  const streamChunks: StreamChunk[] = overrides.streamChunks ?? [
    { type: "content", text: "Finding" },
    { type: "done", usage: { totalTokens: 42 }, model: "mock-model" },
  ];

  const chatCalls: ChatRequest[] = [];

  const provider: ReviewProvider & { chatCalls: ChatRequest[] } = {
    name: "mock",
    chatCalls,

    initialize: vi.fn().mockResolvedValue(undefined),

    chat: vi.fn().mockImplementation((req: ChatRequest) => {
      chatCalls.push(req);
      return Promise.resolve(chatResponse);
    }),

    chatStream: vi.fn().mockImplementation((_req: ChatRequest) => {
      async function* gen() {
        for (const chunk of streamChunks) {
          yield chunk;
        }
      }
      return gen();
    }),

    listModels: vi.fn().mockResolvedValue([MOCK_MODEL_INFO]),

    validateModel: vi.fn().mockResolvedValue(MOCK_MODEL_INFO),

    dispose: vi.fn(),

    healthCheck: vi.fn().mockResolvedValue({ ok: true, latencyMs: 1 }),
  };

  if (overrides.hasAutoSelect !== false) {
    (provider as any).autoSelect = vi.fn().mockResolvedValue("mock-model");
  }

  return provider;
}

// ============================================================================
// review() tests
// ============================================================================

describe("review()", () => {
  const mockDiffResult: DiffResult = {
    raw: "diff --git a/test.ts b/test.ts\n+added line",
    files: [{ path: "test.ts", status: "modified", insertions: 1, deletions: 0 }],
    stats: { filesChanged: 1, insertions: 1, deletions: 0 },
  };

  const mockConfig: ResolvedConfig = {
    model: "mock-model",
    format: "markdown",
    stream: false,
    prompt: "You are a code reviewer.",
    defaultBase: "main",
    ignorePaths: [],
    provider: "copilot",
    providerOptions: {},
    chunking: "auto",
  };

  let mockProvider: ReviewProvider & { chatCalls: ChatRequest[] };

  beforeEach(() => {
    vi.clearAllMocks();
    mockProvider = createMockProvider();
    vi.mocked(collectDiff).mockResolvedValue(mockDiffResult);
  });

  it("executes full pipeline: diff -> model -> budget -> assemble -> call -> format", async () => {
    const options: ReviewOptions = {
      diff: { mode: "unstaged" },
      config: mockConfig,
      model: "mock-model",
    };

    const result = await review(options, mockProvider);

    // Verify pipeline steps
    expect(collectDiff).toHaveBeenCalledWith(expect.objectContaining({ mode: "unstaged", ignorePaths: mockConfig.ignorePaths }));
    expect(mockProvider.validateModel).toHaveBeenCalledWith("mock-model");
    expect(assembleUserMessage).toHaveBeenCalledWith(mockDiffResult);
    expect(mockProvider.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "mock-model",
        systemPrompt: "You are a code reviewer.",
        messages: expect.any(Array),
        stream: false,
      }),
    );
    expect(format).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "### HIGH Security issue found",
        model: "mock-model",
        usage: { totalTokens: 123 },
      }),
      "markdown"
    );

    expect(result.model).toBe("mock-model");
    expect(result.diff).toEqual(mockDiffResult);
  });

  it("returns ReviewResult with content, model, usage, diff, warnings", async () => {
    const options: ReviewOptions = {
      diff: { mode: "staged" },
      config: mockConfig,
      model: "mock-model",
    };

    const result = await review(options, mockProvider);

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

      const result = await review(options, mockProvider);

      expect(result.content).toBe("No changes found.");
      expect(result.model).toBe("none");
      expect(result.usage.totalTokens).toBe(0);
      expect(result.warnings).toHaveLength(0);

      // API should not be called
      expect(mockProvider.chat).not.toHaveBeenCalled();
      expect((mockProvider as any).autoSelect).not.toHaveBeenCalled();
      expect(mockProvider.validateModel).not.toHaveBeenCalled();
    });
  });

  describe("model resolution", () => {
    it("auto mode: calls provider.autoSelect() then validateModel() to get ModelInfo", async () => {
      const options: ReviewOptions = {
        diff: { mode: "unstaged" },
        config: { ...mockConfig, model: "auto" },
        model: "auto",
      };

      await review(options, mockProvider);

      expect((mockProvider as any).autoSelect).toHaveBeenCalled();
      expect(mockProvider.validateModel).toHaveBeenCalledWith("mock-model");
    });

    it("explicit mode: calls validateModel() directly without autoSelect()", async () => {
      const options: ReviewOptions = {
        diff: { mode: "unstaged" },
        config: mockConfig,
        model: "mock-model",
      };

      await review(options, mockProvider);

      expect((mockProvider as any).autoSelect).not.toHaveBeenCalled();
      expect(mockProvider.validateModel).toHaveBeenCalledWith("mock-model");
    });

    it("uses config.model when no explicit model provided", async () => {
      const options: ReviewOptions = {
        diff: { mode: "unstaged" },
        config: { ...mockConfig, model: "mock-model" },
      };

      await review(options, mockProvider);

      expect(mockProvider.validateModel).toHaveBeenCalledWith("mock-model");
    });

    it("provider without autoSelect + model 'auto' throws ConfigError(model_required)", async () => {
      const providerWithoutAutoSelect = createMockProvider({ hasAutoSelect: false });

      const options: ReviewOptions = {
        diff: { mode: "unstaged" },
        config: { ...mockConfig, model: "auto" },
        model: "auto",
      };

      await expect(review(options, providerWithoutAutoSelect)).rejects.toThrow(
        expect.objectContaining({ code: "model_required" })
      );
    });

    it("provider with autoSelect + model 'auto' uses auto-selected model", async () => {
      const options: ReviewOptions = {
        diff: { mode: "unstaged" },
        config: { ...mockConfig, model: "auto" },
        model: "auto",
      };

      const result = await review(options, mockProvider);

      expect((mockProvider as any).autoSelect).toHaveBeenCalled();
      expect(result.model).toBe("mock-model");
    });
  });

  describe("token budget", () => {
    it("estimate < 80% of maxPromptTokens: no warning", async () => {
      // Small diff: ~50 chars system + 100 chars diff = 150 chars / 4 = 37.5 tokens
      // 37.5 / 128000 = tiny fraction (way under 80%)
      const smallDiff: DiffResult = {
        raw: "diff --git a/test.ts b/test.ts\n+small change",
        files: [{ path: "test.ts", status: "modified", insertions: 1, deletions: 0 }],
        stats: { filesChanged: 1, insertions: 1, deletions: 0 },
      };
      vi.mocked(collectDiff).mockResolvedValue(smallDiff);

      const options: ReviewOptions = {
        diff: { mode: "unstaged" },
        config: mockConfig,
        model: "mock-model",
      };

      const result = await review(options, mockProvider);

      expect(result.warnings).toHaveLength(0);
    });

    it("estimate >= 80% and < 100%: adds warning to result", async () => {
      // maxPromptTokens = 128000, need 80%+ = 102400 tokens = ~409600 chars
      // Use a smaller model limit via custom validateModel response
      const smallLimitModel: ModelInfo = { ...MOCK_MODEL_INFO, maxPromptTokens: 8000 };
      vi.mocked(mockProvider.validateModel).mockResolvedValue(smallLimitModel);

      // 8000 * 0.85 = 6800 tokens * 4 chars/token = 27200 chars
      const largeDiff: DiffResult = {
        raw: "x".repeat(25000),
        files: [{ path: "test.ts", status: "modified", insertions: 100, deletions: 50 }],
        stats: { filesChanged: 1, insertions: 100, deletions: 50 },
      };
      vi.mocked(collectDiff).mockResolvedValue(largeDiff);

      const options: ReviewOptions = {
        diff: { mode: "unstaged" },
        config: { ...mockConfig, prompt: "x".repeat(2000) },
        model: "mock-model",
      };

      const result = await review(options, mockProvider);

      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain("Token budget");
    });

    it("estimate >= 100%: throws ReviewError diff_too_large", async () => {
      const smallLimitModel: ModelInfo = { ...MOCK_MODEL_INFO, maxPromptTokens: 8000 };
      vi.mocked(mockProvider.validateModel).mockResolvedValue(smallLimitModel);

      // 8000 * 1.05 = 8400 tokens * 4 chars/token = 33600 chars
      const hugeDiff: DiffResult = {
        raw: "x".repeat(33000),
        files: [{ path: "test.ts", status: "modified", insertions: 1000, deletions: 500 }],
        stats: { filesChanged: 1, insertions: 1000, deletions: 500 },
      };
      vi.mocked(collectDiff).mockResolvedValue(hugeDiff);

      const options: ReviewOptions = {
        diff: { mode: "unstaged" },
        config: { ...mockConfig, prompt: "x".repeat(1000) },
        model: "mock-model",
      };

      const err = await review(options, mockProvider).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ReviewError);
      expect((err as ReviewError).code).toBe("diff_too_large");
      expect((err as ReviewError).suggestion).toBe("Use ignorePaths or a larger-context model");

      // API should not be called
      expect(mockProvider.chat).not.toHaveBeenCalled();
    });
  });

  describe("message assembly", () => {
    it("system message is config.prompt (single concatenated string)", async () => {
      const options: ReviewOptions = {
        diff: { mode: "unstaged" },
        config: { ...mockConfig, prompt: "Custom system prompt." },
        model: "mock-model",
      };

      await review(options, mockProvider);

      expect(mockProvider.chat).toHaveBeenCalledWith(
        expect.objectContaining({
          systemPrompt: "Custom system prompt.",
        }),
      );
    });

    it("user message formatted via assembleUserMessage()", async () => {
      const options: ReviewOptions = {
        diff: { mode: "unstaged" },
        config: mockConfig,
        model: "mock-model",
      };

      await review(options, mockProvider);

      expect(assembleUserMessage).toHaveBeenCalledWith(mockDiffResult);
      expect(mockProvider.chat).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: "user",
              content: expect.stringContaining("Review the following changes"),
            },
          ],
        }),
      );
    });
  });

  describe("ignorePaths", () => {
    it("passes config.ignorePaths to DiffOptions", async () => {
      const options: ReviewOptions = {
        diff: { mode: "unstaged" },
        config: { ...mockConfig, ignorePaths: ["*.test.ts", "node_modules/**"] },
        model: "mock-model",
      };

      await review(options, mockProvider);

      expect(collectDiff).toHaveBeenCalledWith(
        expect.objectContaining({
          ignorePaths: ["*.test.ts", "node_modules/**"],
        })
      );
    });
  });

  describe("empty response", () => {
    it("returns exit code 0 with 'no findings' warning", async () => {
      const providerWithEmptyResponse = createMockProvider({
        chatResponse: {
          content: "",
          model: "mock-model",
          usage: { totalTokens: 50 },
        },
      });

      const options: ReviewOptions = {
        diff: { mode: "unstaged" },
        config: mockConfig,
        model: "mock-model",
      };

      const result = await review(options, providerWithEmptyResponse);

      // Content should be formatted (not raw empty string) — formatter adds structure
      expect(result.content).toBeTruthy();
      expect(result.warnings).toContain("Copilot returned no findings.");
    });
  });
});

// ============================================================================
// reviewStream() tests
// ============================================================================

describe("reviewStream()", () => {
  const mockDiffResult: DiffResult = {
    raw: "diff --git a/test.ts b/test.ts\n+added line",
    files: [{ path: "test.ts", status: "modified", insertions: 1, deletions: 0 }],
    stats: { filesChanged: 1, insertions: 1, deletions: 0 },
  };

  const mockConfig: ResolvedConfig = {
    model: "mock-model",
    format: "markdown",
    stream: true,
    prompt: "You are a code reviewer.",
    defaultBase: "main",
    ignorePaths: [],
    provider: "copilot",
    providerOptions: {},
    chunking: "auto",
  };

  let mockProvider: ReviewProvider & { chatCalls: ChatRequest[] };

  beforeEach(() => {
    vi.clearAllMocks();
    mockProvider = createMockProvider();
    vi.mocked(collectDiff).mockResolvedValue(mockDiffResult);
  });

  it("returns tuple { stream, warnings, diff, model }", async () => {
    const options: ReviewOptions = {
      diff: { mode: "unstaged" },
      config: mockConfig,
      model: "mock-model",
    };

    const result = await reviewStream(options, mockProvider);

    expect(result).toHaveProperty("stream");
    expect(result).toHaveProperty("warnings");
    expect(result).toHaveProperty("diff");
    expect(result).toHaveProperty("model");
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(result.diff).toEqual(mockDiffResult);
    expect(result.model).toBe("mock-model");
  });

  it("warnings computed before stream starts", async () => {
    const smallLimitModel: ModelInfo = { ...MOCK_MODEL_INFO, maxPromptTokens: 8000 };

    const providerWithLimit = createMockProvider({
      streamChunks: [{ type: "content", text: "Finding 1" }],
    });
    vi.mocked(providerWithLimit.validateModel).mockResolvedValue(smallLimitModel);

    const largeDiff: DiffResult = {
      raw: "x".repeat(25000),
      files: [{ path: "test.ts", status: "modified", insertions: 100, deletions: 50 }],
      stats: { filesChanged: 1, insertions: 100, deletions: 50 },
    };
    vi.mocked(collectDiff).mockResolvedValue(largeDiff);

    const options: ReviewOptions = {
      diff: { mode: "unstaged" },
      config: { ...mockConfig, prompt: "x".repeat(2000) },
      model: "mock-model",
    };

    const result = await reviewStream(options, providerWithLimit);

    // Warnings should be available immediately (before consuming stream)
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("Token budget");
  });

  it("stream yields string chunks from provider.chatStream()", async () => {
    const providerWithChunks = createMockProvider({
      streamChunks: [
        { type: "content", text: "Part 1" },
        { type: "content", text: "Part 2" },
        { type: "content", text: "Part 3" },
        { type: "done", usage: { totalTokens: 123 }, model: "mock-model" },
      ],
    });

    const options: ReviewOptions = {
      diff: { mode: "unstaged" },
      config: mockConfig,
      model: "mock-model",
    };

    const result = await reviewStream(options, providerWithChunks);

    const chunks: string[] = [];
    for await (const chunk of result.stream) {
      chunks.push(chunk);
    }

    // Should only yield text strings (not StreamChunk objects)
    expect(chunks).toEqual(["Part 1", "Part 2", "Part 3"]);
  });

  it("model is resolved model ID", async () => {
    const customModel: ModelInfo = { ...MOCK_MODEL_INFO, id: "custom-model" };
    const providerWithCustomModel = createMockProvider({
      streamChunks: [{ type: "content", text: "Finding" }],
    });
    vi.mocked(providerWithCustomModel.validateModel).mockResolvedValue(customModel);

    const options: ReviewOptions = {
      diff: { mode: "unstaged" },
      config: mockConfig,
      model: "custom-model",
    };

    const result = await reviewStream(options, providerWithCustomModel);

    expect(result.model).toBe("custom-model");
  });

  it("diff is DiffResult metadata", async () => {
    const options: ReviewOptions = {
      diff: { mode: "staged" },
      config: mockConfig,
      model: "mock-model",
    };

    const result = await reviewStream(options, mockProvider);

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

    await expect(reviewStream(options, mockProvider)).rejects.toThrow(DiffError);
  });

  it("passes ignorePaths to collectDiff", async () => {
    const options: ReviewOptions = {
      diff: { mode: "unstaged" },
      config: { ...mockConfig, ignorePaths: ["*.log", "dist/**"] },
      model: "mock-model",
    };

    await reviewStream(options, mockProvider);

    expect(collectDiff).toHaveBeenCalledWith(
      expect.objectContaining({
        ignorePaths: ["*.log", "dist/**"],
      })
    );
  });

  it("captures usage from done chunk after stream is consumed", async () => {
    const providerWithUsage = createMockProvider({
      streamChunks: [
        { type: "content", text: "Finding" },
        { type: "done", usage: { totalTokens: 42 }, model: "mock-model" },
      ],
    });

    const options: ReviewOptions = {
      diff: { mode: "unstaged" },
      config: mockConfig,
      model: "mock-model",
    };

    const result = await reviewStream(options, providerWithUsage);
    expect(result.usage).toBeUndefined(); // not yet consumed

    for await (const _ of result.stream) { /* drain */ }

    expect(result.usage).toEqual({ totalTokens: 42 });
  });

  it("usage remains undefined when done chunk has no usage", async () => {
    const providerWithNoUsage = createMockProvider({
      streamChunks: [
        { type: "content", text: "Finding" },
        { type: "done" },
      ],
    });

    const options: ReviewOptions = {
      diff: { mode: "unstaged" },
      config: mockConfig,
      model: "mock-model",
    };

    const result = await reviewStream(options, providerWithNoUsage);
    for await (const _ of result.stream) { /* drain */ }

    expect(result.usage).toBeUndefined();
  });

  it("provider without autoSelect + model 'auto' throws ConfigError(model_required)", async () => {
    const providerWithoutAutoSelect = createMockProvider({ hasAutoSelect: false });

    const options: ReviewOptions = {
      diff: { mode: "unstaged" },
      config: { ...mockConfig, model: "auto" },
      model: "auto",
    };

    await expect(reviewStream(options, providerWithoutAutoSelect)).rejects.toThrow(
      expect.objectContaining({ code: "model_required" })
    );
  });
});
