// test/lib/review.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { review, reviewStream, shouldChunk } from "../../src/lib/review.js";
import type {
  ReviewOptions,
  DiffResult,
  ChatResponse,
  ModelInfo,
  StreamChunk,
  ResolvedConfig,
  ChatRequest,
  ChunkedReviewResult,
} from "../../src/lib/types.js";
import { ClientError, DiffError, ReviewError } from "../../src/lib/types.js";
import type { ReviewProvider } from "../../src/lib/providers/types.js";

// Mock all dependencies
vi.mock("../../src/lib/diff.js", () => ({
  collectDiff: vi.fn(),
}));

vi.mock("../../src/lib/prompt.js", () => ({
  assembleUserMessage: vi.fn((diff) => `Review the following changes.\n\n## Summary\nFiles changed: ${diff.stats.filesChanged}\nInsertions: +${diff.stats.insertions}, Deletions: -${diff.stats.deletions}\n\n## Diff\n\`\`\`diff\n${diff.raw}\n\`\`\``),
  assembleChunkMessage: vi.fn((_i, _total, segs, _manifest) => `chunk message for ${segs.map((s: { path: string }) => s.path).join(",")}`),
  assembleReduceMessage: vi.fn(() => "reduce message"),
  assembleFileManifest: vi.fn(() => "file manifest"),
  extractHunkRanges: vi.fn(() => new Map()),
  getReduceSystemPrompt: vi.fn(() => "You are a code review aggregator."),
}));

vi.mock("../../src/lib/chunking.js", () => ({
  splitDiffByFile: vi.fn(),
  binPackFiles: vi.fn(),
}));

vi.mock("../../src/lib/truncation.js", () => ({
  truncateForReduce: vi.fn((chunks: string[]) => ({
    truncated: chunks,
    warnings: [],
    didTruncate: false,
  })),
}));

vi.mock("../../src/lib/formatter.js", () => ({
  format: vi.fn((result, fmt) => `formatted:${fmt}:${result.content}`),
  detectHighSeverity: vi.fn(() => false),
}));

import { collectDiff } from "../../src/lib/diff.js";
import { assembleUserMessage } from "../../src/lib/prompt.js";
import { format } from "../../src/lib/formatter.js";
import { splitDiffByFile, binPackFiles } from "../../src/lib/chunking.js";

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

class MockProvider implements ReviewProvider {
  readonly name = "mock";
  chatCalls: ChatRequest[] = [];
  autoSelect?: () => Promise<string>;

  private _chatResponse: ChatResponse;
  private _streamChunks: StreamChunk[];
  // When set, provider returns each response in sequence, cycling the last one
  private _chatResponses?: ChatResponse[];

  constructor(chatResponse: ChatResponse, streamChunks: StreamChunk[]) {
    this._chatResponse = chatResponse;
    this._streamChunks = streamChunks;
  }

  setSequentialResponses(responses: ChatResponse[]) {
    this._chatResponses = responses;
  }

  initialize = vi.fn().mockResolvedValue(undefined);

  chat = vi.fn().mockImplementation((req: ChatRequest) => {
    this.chatCalls.push(req);
    if (this._chatResponses && this._chatResponses.length > 0) {
      const idx = Math.min(this.chatCalls.length - 1, this._chatResponses.length - 1);
      return Promise.resolve(this._chatResponses[idx]);
    }
    return Promise.resolve(this._chatResponse);
  });

  chatStream = vi.fn().mockImplementation((_req: ChatRequest) => {
    const chunks = this._streamChunks;
    async function* gen() {
      for (const chunk of chunks) {
        yield chunk;
      }
    }
    return gen();
  });

  listModels = vi.fn().mockResolvedValue([MOCK_MODEL_INFO]);
  validateModel = vi.fn().mockResolvedValue(MOCK_MODEL_INFO);
  dispose = vi.fn();
  healthCheck = vi.fn().mockResolvedValue({ ok: true, latencyMs: 1 });
}

function createMockProvider(overrides: {
  chatResponse?: ChatResponse;
  streamChunks?: StreamChunk[];
  hasAutoSelect?: boolean;
  modelInfo?: ModelInfo;
} = {}): MockProvider {
  const chatResponse: ChatResponse = overrides.chatResponse ?? {
    content: "### HIGH Security issue found",
    model: "mock-model",
    usage: { totalTokens: 123 },
  };

  const streamChunks: StreamChunk[] = overrides.streamChunks ?? [
    { type: "content", text: "Finding" },
    { type: "done", usage: { totalTokens: 42 }, model: "mock-model" },
  ];

  const provider = new MockProvider(chatResponse, streamChunks);
  const modelInfo = overrides.modelInfo ?? MOCK_MODEL_INFO;
  vi.mocked(provider.validateModel).mockResolvedValue(modelInfo);

  if (overrides.hasAutoSelect !== false) {
    provider.autoSelect = vi.fn().mockResolvedValue("mock-model");
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

  let mockProvider: MockProvider;

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
      expect(mockProvider.autoSelect).not.toHaveBeenCalled();
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

      expect(mockProvider.autoSelect).toHaveBeenCalled();
      expect(mockProvider.validateModel).toHaveBeenCalledWith("mock-model");
    });

    it("explicit mode: calls validateModel() directly without autoSelect()", async () => {
      const options: ReviewOptions = {
        diff: { mode: "unstaged" },
        config: mockConfig,
        model: "mock-model",
      };

      await review(options, mockProvider);

      expect(mockProvider.autoSelect).not.toHaveBeenCalled();
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

      expect(mockProvider.autoSelect).toHaveBeenCalled();
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

      // 8000 * 0.80 = 6400 tokens * 4 chars/token = 25600 chars — use 27000 chars to land at ~85%
      const largeDiff: DiffResult = {
        raw: "x".repeat(25000),
        files: [{ path: "test.ts", status: "modified", insertions: 100, deletions: 50 }],
        stats: { filesChanged: 1, insertions: 100, deletions: 50 },
      };
      vi.mocked(collectDiff).mockResolvedValue(largeDiff);

      const options: ReviewOptions = {
        diff: { mode: "unstaged" },
        // Use chunking: "never" to exercise single-pass budget warning path
        config: { ...mockConfig, chunking: "never", prompt: "x".repeat(2000) },
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
        // Use chunking: "never" to exercise single-pass diff_too_large error path
        config: { ...mockConfig, chunking: "never", prompt: "x".repeat(1000) },
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
      expect(result.content).toBe("formatted:markdown:");
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

  let mockProvider: MockProvider;

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

    // Large diff will trigger shouldChunk() — set up chunking mocks so the path doesn't crash.
    // Single segment → single chunk → chatStream used directly (no map-reduce).
    const seg = { path: "test.ts", raw: "x".repeat(25000), estimatedTokens: 6250, hunks: [] };
    vi.mocked(splitDiffByFile).mockReturnValue({ segments: [seg], warnings: [] });
    vi.mocked(binPackFiles).mockReturnValue([[seg]]);

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

// ============================================================================
// reviewStream() — chunked streaming pipeline
// ============================================================================

describe("reviewStream() — chunked streaming pipeline", () => {
  // Model with 10000 token context — small enough to trigger auto-chunking on large diffs
  const modelInfo10k: ModelInfo = { ...MOCK_MODEL_INFO, maxPromptTokens: 10000 };

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

  // A diff large enough to trigger auto-chunking on modelInfo10k
  // estimate = (26 + 32000) / 4 = 8006 tokens; 10000 * 0.8 = 8000 → 8006 >= 8000 → chunk
  const autoChunkDiff: DiffResult = {
    raw: "diff --git a/a.ts b/a.ts\n+" + "x".repeat(32000),
    files: [
      { path: "a.ts", status: "modified", insertions: 100, deletions: 0 },
      { path: "b.ts", status: "modified", insertions: 100, deletions: 0 },
      { path: "c.ts", status: "modified", insertions: 100, deletions: 0 },
    ],
    stats: { filesChanged: 3, insertions: 300, deletions: 0 },
  };

  const smallDiff: DiffResult = {
    raw: "diff --git a/a.ts b/a.ts\n+small change",
    files: [{ path: "a.ts", status: "modified", insertions: 1, deletions: 0 }],
    stats: { filesChanged: 1, insertions: 1, deletions: 0 },
  };

  const segA = { path: "a.ts", raw: "diff a", estimatedTokens: 20, hunks: [] };
  const segB = { path: "b.ts", raw: "diff b", estimatedTokens: 20, hunks: [] };
  const segC = { path: "c.ts", raw: "diff c", estimatedTokens: 20, hunks: [] };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("large diff + chunking:'auto' → chat for map, chatStream for reduce (not chat)", async () => {
    const provider = createMockProvider({
      modelInfo: modelInfo10k,
      chatResponse: { content: "finding", model: "mock-model", usage: { totalTokens: 10 } },
      streamChunks: [
        { type: "content", text: "Aggregated finding" },
        { type: "done", usage: { totalTokens: 30 }, model: "mock-model" },
      ],
    });
    vi.mocked(collectDiff).mockResolvedValue(autoChunkDiff);
    vi.mocked(splitDiffByFile).mockReturnValue({ segments: [segA, segB, segC], warnings: [] });
    vi.mocked(binPackFiles).mockReturnValue([[segA], [segB], [segC]]);

    const options: ReviewOptions = {
      diff: { mode: "unstaged" },
      config: { ...mockConfig, chunking: "auto" },
      model: "mock-model",
    };

    const result = await reviewStream(options, provider);

    // MAP: 3 chunks → 3 calls to provider.chat
    expect(provider.chat).toHaveBeenCalledTimes(3);

    // Drain the stream to trigger reduce
    const chunks: string[] = [];
    for await (const chunk of result.stream) {
      chunks.push(chunk);
    }

    // REDUCE: 1 call to provider.chatStream (not provider.chat)
    expect(provider.chatStream).toHaveBeenCalledTimes(1);
    expect(chunks).toEqual(["Aggregated finding"]);
    // chat should still be 3 (reduce used chatStream, not chat)
    expect(provider.chat).toHaveBeenCalledTimes(3);
  });

  it("single chunk → chatStream called for that chunk, chat not called", async () => {
    const provider = createMockProvider({
      modelInfo: modelInfo10k,
      streamChunks: [
        { type: "content", text: "Single chunk finding" },
        { type: "done", usage: { totalTokens: 15 }, model: "mock-model" },
      ],
    });

    const smallConfigDiff: DiffResult = {
      raw: "diff --git a/a.ts b/a.ts\n+x",
      files: [{ path: "a.ts", status: "modified", insertions: 1, deletions: 0 }],
      stats: { filesChanged: 1, insertions: 1, deletions: 0 },
    };

    vi.mocked(collectDiff).mockResolvedValue(smallConfigDiff);
    vi.mocked(splitDiffByFile).mockReturnValue({ segments: [segA], warnings: [] });
    vi.mocked(binPackFiles).mockReturnValue([[segA]]);

    const options: ReviewOptions = {
      diff: { mode: "unstaged" },
      // chunking: "always" forces the chunked path even for small diff
      config: { ...mockConfig, chunking: "always" },
      model: "mock-model",
    };

    const result = await reviewStream(options, provider);

    // chat should NOT be called for single-chunk streaming path
    expect(provider.chat).not.toHaveBeenCalled();

    const chunks: string[] = [];
    for await (const chunk of result.stream) {
      chunks.push(chunk);
    }

    expect(provider.chatStream).toHaveBeenCalledTimes(1);
    expect(chunks).toEqual(["Single chunk finding"]);
  });

  it("map phase uses chat (buffered), reduce uses chatStream (streaming)", async () => {
    const provider = createMockProvider({
      modelInfo: modelInfo10k,
      streamChunks: [
        { type: "content", text: "Streamed reduce output" },
        { type: "done", usage: { totalTokens: 50 }, model: "mock-model" },
      ],
    });
    provider.setSequentialResponses([
      { content: "chunk A findings", model: "mock-model", usage: { totalTokens: 10 } },
      { content: "chunk B findings", model: "mock-model", usage: { totalTokens: 10 } },
    ]);

    vi.mocked(collectDiff).mockResolvedValue(autoChunkDiff);
    vi.mocked(splitDiffByFile).mockReturnValue({ segments: [segA, segB], warnings: [] });
    vi.mocked(binPackFiles).mockReturnValue([[segA], [segB]]);

    const options: ReviewOptions = {
      diff: { mode: "unstaged" },
      config: { ...mockConfig, chunking: "always" },
      model: "mock-model",
    };

    const result = await reviewStream(options, provider);

    // Before consuming stream: map is done (2 chat calls), chatStream not yet called
    expect(provider.chat).toHaveBeenCalledTimes(2);
    // chatStream is invoked during setup (returns the AsyncIterable) but we check it was called
    expect(provider.chatStream).toHaveBeenCalledTimes(1);

    const chunks: string[] = [];
    for await (const chunk of result.stream) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["Streamed reduce output"]);
    // chat count hasn't changed — reduce used chatStream
    expect(provider.chat).toHaveBeenCalledTimes(2);
  });

  it("progress markers emitted to stderr between map chunks when stderr.isTTY", async () => {
    const stderrWriteSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const originalIsTTY = process.stderr.isTTY;
    Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });

    try {
      const provider = createMockProvider({
        modelInfo: modelInfo10k,
        chatResponse: { content: "finding", model: "mock-model", usage: { totalTokens: 10 } },
        streamChunks: [
          { type: "content", text: "Aggregated" },
          { type: "done", usage: { totalTokens: 20 }, model: "mock-model" },
        ],
      });

      vi.mocked(collectDiff).mockResolvedValue(autoChunkDiff);
      vi.mocked(splitDiffByFile).mockReturnValue({ segments: [segA, segB, segC], warnings: [] });
      vi.mocked(binPackFiles).mockReturnValue([[segA], [segB], [segC]]);

      const options: ReviewOptions = {
        diff: { mode: "unstaged" },
        config: { ...mockConfig, chunking: "always" },
        model: "mock-model",
      };

      const result = await reviewStream(options, provider);
      // Drain stream to complete reduce
      for await (const _ of result.stream) { /* drain */ }

      const stderrCalls = stderrWriteSpy.mock.calls.map((c) => c[0] as string);

      // Should have progress messages for each map chunk
      const chunkMessages = stderrCalls.filter((s) => s.includes("Reviewing chunk"));
      expect(chunkMessages.length).toBe(3);

      // Should have the "Aggregating findings..." message before reduce
      const aggregateMsg = stderrCalls.find((s) => s.includes("Aggregating findings"));
      expect(aggregateMsg).toBeDefined();
    } finally {
      Object.defineProperty(process.stderr, "isTTY", { value: originalIsTTY, configurable: true });
      stderrWriteSpy.mockRestore();
    }
  });
});

// ============================================================================
// shouldChunk() tests
// ============================================================================

describe("shouldChunk()", () => {
  const baseConfig: ResolvedConfig = {
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

  const modelInfo: ModelInfo = { ...MOCK_MODEL_INFO, maxPromptTokens: 10000 };

  it("auto + small diff (< 80% of context) → false", () => {
    // prompt=26 chars + diff=100 chars = 126 chars / 4 = 31.5 tokens → 0.3% of 10000
    const smallDiff: DiffResult = {
      raw: "x".repeat(100),
      files: [],
      stats: { filesChanged: 1, insertions: 1, deletions: 0 },
    };
    expect(shouldChunk({ ...baseConfig, chunking: "auto" }, smallDiff, modelInfo)).toBe(false);
  });

  it("auto + large diff (>= 80% of context) → true", () => {
    // 10000 * 0.8 * 4 = 32000 chars total needed. prompt=26, so diff needs 32000 chars
    const largeDiff: DiffResult = {
      raw: "x".repeat(32000),
      files: [],
      stats: { filesChanged: 1, insertions: 100, deletions: 50 },
    };
    expect(shouldChunk({ ...baseConfig, chunking: "auto" }, largeDiff, modelInfo)).toBe(true);
  });

  it("chunking: 'always' → true regardless of diff size", () => {
    const smallDiff: DiffResult = {
      raw: "x".repeat(10),
      files: [],
      stats: { filesChanged: 1, insertions: 1, deletions: 0 },
    };
    expect(shouldChunk({ ...baseConfig, chunking: "always" }, smallDiff, modelInfo)).toBe(true);
  });

  it("chunking: 'never' → false regardless of diff size", () => {
    const hugeDiff: DiffResult = {
      raw: "x".repeat(500000),
      files: [],
      stats: { filesChanged: 10, insertions: 5000, deletions: 2000 },
    };
    expect(shouldChunk({ ...baseConfig, chunking: "never" }, hugeDiff, modelInfo)).toBe(false);
  });
});

// ============================================================================
// chunked review() tests
// ============================================================================

describe("review() — map-reduce chunked pipeline", () => {
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

  // Model with 10000 token context — large enough to have a viable chunkBudget
  // (10000 - 6 - 150 = 9844) but small enough that an 80%-threshold test can
  // be triggered by a ~32 000-char diff (32000/4 = 8000 tokens > 10000*0.8).
  const modelInfo10k: ModelInfo = { ...MOCK_MODEL_INFO, maxPromptTokens: 10000 };

  const smallDiff: DiffResult = {
    raw: "diff --git a/a.ts b/a.ts\n+small",
    files: [{ path: "a.ts", status: "modified", insertions: 1, deletions: 0 }],
    stats: { filesChanged: 1, insertions: 1, deletions: 0 },
  };

  // A diff large enough to trigger auto-chunking on modelInfo10k:
  // estimate = (26 + 32000) / 4 = 8006 tokens; 10000 * 0.8 = 8000 → 8006 >= 8000 → chunk
  const autoChunkDiff: DiffResult = {
    raw: "diff --git a/a.ts b/a.ts\n+" + "x".repeat(32000),
    files: [
      { path: "a.ts", status: "modified", insertions: 100, deletions: 0 },
      { path: "b.ts", status: "modified", insertions: 100, deletions: 0 },
      { path: "c.ts", status: "modified", insertions: 100, deletions: 0 },
    ],
    stats: { filesChanged: 3, insertions: 300, deletions: 0 },
  };

  // A smaller multi-file diff used in "always" chunking tests
  const largeDiff: DiffResult = {
    raw: "diff --git a/a.ts b/a.ts\n+x",
    files: [
      { path: "a.ts", status: "modified", insertions: 100, deletions: 0 },
      { path: "b.ts", status: "modified", insertions: 100, deletions: 0 },
      { path: "c.ts", status: "modified", insertions: 100, deletions: 0 },
    ],
    stats: { filesChanged: 3, insertions: 300, deletions: 0 },
  };

  const segA = { path: "a.ts", raw: "diff a", estimatedTokens: 20, hunks: [] };
  const segB = { path: "b.ts", raw: "diff b", estimatedTokens: 20, hunks: [] };
  const segC = { path: "c.ts", raw: "diff c", estimatedTokens: 20, hunks: [] };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("small diff → single pass (provider.chat called once)", async () => {
    const provider = createMockProvider({ modelInfo: { ...MOCK_MODEL_INFO, maxPromptTokens: 128000 } });
    vi.mocked(collectDiff).mockResolvedValue(smallDiff);

    const options: ReviewOptions = {
      diff: { mode: "unstaged" },
      config: { ...mockConfig, chunking: "auto" },
      model: "mock-model",
    };

    await review(options, provider);

    expect(provider.chat).toHaveBeenCalledTimes(1);
    expect(assembleUserMessage).toHaveBeenCalledWith(smallDiff);
  });

  it("large diff + chunking: 'auto' → chunked path (chat called N+1 times for map+reduce)", async () => {
    const provider = createMockProvider({ modelInfo: modelInfo10k });
    // autoChunkDiff is large enough to cross the 80% threshold on modelInfo10k
    vi.mocked(collectDiff).mockResolvedValue(autoChunkDiff);

    // 3 segments → 3 chunks (one per file)
    vi.mocked(splitDiffByFile).mockReturnValue({ segments: [segA, segB, segC], warnings: [] });
    vi.mocked(binPackFiles).mockReturnValue([[segA], [segB], [segC]]);

    provider.setSequentialResponses([
      { content: "finding A", model: "mock-model", usage: { totalTokens: 10 } },
      { content: "finding B", model: "mock-model", usage: { totalTokens: 10 } },
      { content: "finding C", model: "mock-model", usage: { totalTokens: 10 } },
      { content: "### HIGH final unified review", model: "mock-model", usage: { totalTokens: 30 } },
    ]);

    const options: ReviewOptions = {
      diff: { mode: "unstaged" },
      config: { ...mockConfig, chunking: "auto" },
      model: "mock-model",
    };

    const result = await review(options, provider);

    // 3 map + 1 reduce = 4 total
    expect(provider.chat).toHaveBeenCalledTimes(4);
    expect(result).toHaveProperty("chunked", true);
  });

  it("1 chunk → reduce skipped (provider.chat called exactly 1 time)", async () => {
    const provider = createMockProvider({ modelInfo: modelInfo10k });
    vi.mocked(collectDiff).mockResolvedValue(largeDiff);

    // Single chunk → no reduce
    vi.mocked(splitDiffByFile).mockReturnValue({ segments: [segA], warnings: [] });
    vi.mocked(binPackFiles).mockReturnValue([[segA]]);

    const options: ReviewOptions = {
      diff: { mode: "unstaged" },
      config: { ...mockConfig, chunking: "always" },
      model: "mock-model",
    };

    await review(options, provider);

    expect(provider.chat).toHaveBeenCalledTimes(1);
  });

  it("3 chunks → 3 map calls + 1 reduce call (4 total)", async () => {
    const provider = createMockProvider({ modelInfo: modelInfo10k });
    vi.mocked(collectDiff).mockResolvedValue(largeDiff);

    vi.mocked(splitDiffByFile).mockReturnValue({ segments: [segA, segB, segC], warnings: [] });
    vi.mocked(binPackFiles).mockReturnValue([[segA], [segB], [segC]]);

    provider.setSequentialResponses([
      { content: "finding A", model: "mock-model", usage: { totalTokens: 10 } },
      { content: "finding B", model: "mock-model", usage: { totalTokens: 10 } },
      { content: "finding C", model: "mock-model", usage: { totalTokens: 10 } },
      { content: "final", model: "mock-model", usage: { totalTokens: 5 } },
    ]);

    const options: ReviewOptions = {
      diff: { mode: "unstaged" },
      config: { ...mockConfig, chunking: "always" },
      model: "mock-model",
    };

    await review(options, provider);

    expect(provider.chat).toHaveBeenCalledTimes(4);
  });

  it("chunk usage summed correctly: total = sum of all chunk + reduce tokens", async () => {
    const provider = createMockProvider({ modelInfo: modelInfo10k });
    vi.mocked(collectDiff).mockResolvedValue(largeDiff);

    vi.mocked(splitDiffByFile).mockReturnValue({ segments: [segA, segB], warnings: [] });
    vi.mocked(binPackFiles).mockReturnValue([[segA], [segB]]);

    provider.setSequentialResponses([
      { content: "finding A", model: "mock-model", usage: { totalTokens: 100 } },
      { content: "finding B", model: "mock-model", usage: { totalTokens: 200 } },
      { content: "final", model: "mock-model", usage: { totalTokens: 50 } },
    ]);

    const options: ReviewOptions = {
      diff: { mode: "unstaged" },
      config: { ...mockConfig, chunking: "always" },
      model: "mock-model",
    };

    const result = await review(options, provider);

    // total = 100 + 200 + 50 = 350
    expect(result.usage.totalTokens).toBe(350);
    const chunked = result as ChunkedReviewResult;
    expect(chunked.chunked).toBe(true);
    expect(chunked.reduceUsage.totalTokens).toBe(50);
    expect(chunked.chunks[0].usage.totalTokens).toBe(100);
    expect(chunked.chunks[1].usage.totalTokens).toBe(200);
  });

  it("reduce failure → fallback to raw per-chunk findings with warning prefix", async () => {
    const provider = createMockProvider({ modelInfo: modelInfo10k });
    vi.mocked(collectDiff).mockResolvedValue(largeDiff);

    vi.mocked(splitDiffByFile).mockReturnValue({ segments: [segA, segB], warnings: [] });
    vi.mocked(binPackFiles).mockReturnValue([[segA], [segB]]);

    let callCount = 0;
    vi.mocked(provider.chat).mockImplementation((req: ChatRequest) => {
      provider.chatCalls.push(req);
      callCount++;
      if (callCount <= 2) {
        return Promise.resolve({ content: `finding ${callCount}`, model: "mock-model", usage: { totalTokens: 10 } });
      }
      // Reduce call fails
      return Promise.reject(new Error("API error during reduce"));
    });

    const options: ReviewOptions = {
      diff: { mode: "unstaged" },
      config: { ...mockConfig, chunking: "always" },
      model: "mock-model",
    };

    const result = await review(options, provider);

    // Should still succeed with fallback content
    expect(result.content).toContain("Aggregation failed");
    expect(result.warnings.some(w => w.includes("reduce") || w.includes("Reduce"))).toBe(true);
  });

  it("MAP: context-length error on chunk → re-bins with 0.8x budget and retries sub-chunks", async () => {
    const provider = createMockProvider({ modelInfo: modelInfo10k });
    vi.mocked(collectDiff).mockResolvedValue(largeDiff);

    // Two chunks: first chunk [segA, segB] will fail with context-length error
    // binPackFiles is called first with chunkBudget (initial packing), then with
    // reducedBudget when the context-length retry happens
    vi.mocked(splitDiffByFile).mockReturnValue({ segments: [segA, segB, segC], warnings: [] });
    vi.mocked(binPackFiles)
      .mockReturnValueOnce([[segA, segB], [segC]])   // initial bin-pack: 2 chunks
      .mockReturnValueOnce([[segA], [segB]]);          // retry bin-pack for chunk 0 with 0.8x budget

    const contextLengthErr = new ClientError(
      "context_length_exceeded",
      "This model's maximum context length is exceeded.",
      false,
    );

    let callCount = 0;
    vi.mocked(provider.chat).mockImplementation((req: ChatRequest) => {
      provider.chatCalls.push(req);
      callCount++;
      // First call (chunk 0) throws context-length error
      if (callCount === 1) return Promise.reject(contextLengthErr);
      // Sub-chunk retries and chunk 1 all succeed
      return Promise.resolve({
        content: `finding ${callCount}`,
        model: "mock-model",
        usage: { totalTokens: 5 },
      });
    });

    const options: ReviewOptions = {
      diff: { mode: "unstaged" },
      config: { ...mockConfig, chunking: "always" },
      model: "mock-model",
    };

    const result = await review(options, provider);

    // binPackFiles should have been called twice: initial + retry
    expect(binPackFiles).toHaveBeenCalledTimes(2);

    // The second call to binPackFiles should use the reduced budget (0.8x of chunkBudget)
    // chunkBudget = 10000 - Math.floor(26/4) - 150 = 10000 - 6 - 150 = 9844
    // reducedBudget = Math.floor(9844 * 0.8) = 7875
    const calls = vi.mocked(binPackFiles).mock.calls;
    expect(calls[1][1]).toBe(Math.floor(9844 * 0.8));

    // 3 sub-chunks from rebinning + chunk 1 + reduce = 4 chat calls (initial fails + 3 succeed for map + 1 reduce)
    // Actually: 1 fail + 2 sub-chunk successes + 1 chunk[segC] success + 1 reduce = 5 calls total
    expect(provider.chat).toHaveBeenCalledTimes(5);

    // Result should be chunked
    expect(result).toHaveProperty("chunked", true);
  });

  it("MAP: non-context-length error on chunk N → throws ReviewError(chunk_failed)", async () => {
    const provider = createMockProvider({ modelInfo: modelInfo10k });
    vi.mocked(collectDiff).mockResolvedValue(largeDiff);

    vi.mocked(splitDiffByFile).mockReturnValue({ segments: [segA, segB, segC], warnings: [] });
    vi.mocked(binPackFiles).mockReturnValue([[segA], [segB], [segC]]);

    const authErr = new ClientError("unauthorized", "Invalid token.", false);

    let callCount = 0;
    vi.mocked(provider.chat).mockImplementation((req: ChatRequest) => {
      provider.chatCalls.push(req);
      callCount++;
      if (callCount === 2) return Promise.reject(authErr);
      return Promise.resolve({ content: `finding ${callCount}`, model: "mock-model", usage: { totalTokens: 5 } });
    });

    const options: ReviewOptions = {
      diff: { mode: "unstaged" },
      config: { ...mockConfig, chunking: "always" },
      model: "mock-model",
    };

    const err = await review(options, provider).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ReviewError);
    expect((err as ReviewError).code).toBe("chunk_failed");
    expect((err as ReviewError).message).toContain("chunk 2/3");
    expect((err as ReviewError).message).toContain("b.ts");
    expect((err as ReviewError).cause).toBe(authErr);
  });
});
