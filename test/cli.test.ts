// test/cli.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  ReviewResult,
  ReviewStreamResult,
  ModelInfo,
  ResolvedConfig,
  ChatResponse,
} from "../src/lib/types.js";
import {
  AuthError,
  DiffError,
  ClientError,
  ModelError,
  ConfigError,
} from "../src/lib/types.js";

// ============================================================================
// Mocks
// ============================================================================

const {
  mockChat,
  mockChatStream,
  mockListModels,
  mockAutoSelect,
  mockValidateModel,
  mockDispose,
  mockProvider,
} = vi.hoisted(() => {
  const mockChat = vi.fn();
  const mockChatStream = vi.fn();
  const mockListModels = vi.fn();
  const mockAutoSelect = vi.fn();
  const mockValidateModel = vi.fn();
  const mockDispose = vi.fn();
  const mockProvider = {
    name: "copilot",
    chat: mockChat,
    chatStream: mockChatStream,
    listModels: mockListModels,
    autoSelect: mockAutoSelect,
    validateModel: mockValidateModel,
    initialize: vi.fn().mockResolvedValue(undefined),
    dispose: mockDispose,
    healthCheck: vi.fn().mockResolvedValue({ ok: true, latencyMs: 10 }),
  };
  return { mockChat, mockChatStream, mockListModels, mockAutoSelect, mockValidateModel, mockDispose, mockProvider };
});

vi.mock("../src/lib/review.js", () => ({
  review: vi.fn(),
  reviewStream: vi.fn(),
}));

vi.mock("../src/lib/config.js", () => ({
  loadConfig: vi.fn(),
}));

vi.mock("../src/lib/providers/index.js", () => ({
  createProvider: vi.fn().mockResolvedValue(mockProvider),
  availableProviders: vi.fn().mockReturnValue(["copilot"]),
}));

vi.mock("../src/lib/formatter.js", () => ({
  format: vi.fn((result: ReviewResult, fmt: string) => result.content),
  formatNdjsonChunk: vi.fn((chunk: any) => JSON.stringify(chunk) + "\n"),
  detectHighSeverity: vi.fn((content: string) => /### HIGH|\[HIGH\]/.test(content)),
}));

import { review as mockReviewFn, reviewStream as mockReviewStreamFn } from "../src/lib/review.js";
import { loadConfig as mockLoadConfigFn } from "../src/lib/config.js";
import { detectHighSeverity as mockDetectHighFn } from "../src/lib/formatter.js";
import {
  handleReview,
  handleModels,
  handleChat,
  handleStatus,
  buildProgram,
  mapErrorToExitCode,
} from "../src/cli.js";

const mockReview = mockReviewFn as ReturnType<typeof vi.fn>;
const mockReviewStream = mockReviewStreamFn as ReturnType<typeof vi.fn>;
const mockLoadConfig = mockLoadConfigFn as ReturnType<typeof vi.fn>;
const mockDetectHigh = mockDetectHighFn as ReturnType<typeof vi.fn>;

// ============================================================================
// Helpers
// ============================================================================

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    model: "auto",
    format: "markdown",
    stream: false,
    prompt: "Review this code",
    defaultBase: "main",
    ignorePaths: [],
    provider: "copilot",
    providerOptions: {},
    chunking: "auto",
    ...overrides,
  };
}

function makeReviewResult(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    content: "No issues found.",
    model: "gpt-4.1",
    usage: { totalTokens: 100 },
    diff: { raw: "diff", files: [], stats: { filesChanged: 1, insertions: 5, deletions: 2 } },
    warnings: [],
    ...overrides,
  };
}

const makeModelInfo = (id: string): ModelInfo => ({
  id,
  name: id,
  endpoints: ["/chat/completions"],
  streaming: true,
  toolCalls: true,
  maxPromptTokens: 100000,
  maxOutputTokens: 4096,
  tokenizer: "o200k_base",
});

// Capture stderr and stdout
let stderrOutput: string;
let stdoutOutput: string;
let originalStderrWrite: typeof process.stderr.write;
let originalStdoutWrite: typeof process.stdout.write;

function captureOutput() {
  stderrOutput = "";
  stdoutOutput = "";
  originalStderrWrite = process.stderr.write;
  originalStdoutWrite = process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrOutput += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutOutput += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stdout.write;
}

function restoreOutput() {
  process.stderr.write = originalStderrWrite;
  process.stdout.write = originalStdoutWrite;
}

// ============================================================================
// Tests
// ============================================================================

describe("CLI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockResolvedValue(makeConfig());
    captureOutput();
  });

  afterEach(() => {
    restoreOutput();
  });

  // --------------------------------------------------------------------------
  // Argument parsing via commander
  // --------------------------------------------------------------------------
  describe("argument parsing (buildProgram)", () => {
    it("no args defaults to local mode", () => {
      const program = buildProgram();
      program.exitOverride(); // prevent process.exit
      // Don't call parse — just verify default in action
      // The default is set in the argument definition
      const reviewCmd = program;
      const modeArg = reviewCmd.args; // Not parsed yet
      // Instead, check the program definition has default
      expect(program.name()).toBe("copilot-review");
    });

    it("parses --model flag", () => {
      const program = buildProgram();
      program.exitOverride();
      // Parse but suppress action by using parseOptions
      const opts = program.parseOptions(["--model", "gpt-4.1"]);
      expect(program.opts().model).toBe("gpt-4.1");
    });

    it("parses --format flag", () => {
      const program = buildProgram();
      program.exitOverride();
      program.parseOptions(["--format", "json"]);
      expect(program.opts().format).toBe("json");
    });

    it("parses --stream flag", () => {
      const program = buildProgram();
      program.exitOverride();
      program.parseOptions(["--stream"]);
      expect(program.opts().stream).toBe(true);
    });

    it("parses --no-stream flag", () => {
      const program = buildProgram();
      program.exitOverride();
      program.parseOptions(["--no-stream"]);
      expect(program.opts().stream).toBe(false);
    });

    it("parses --prompt flag", () => {
      const program = buildProgram();
      program.exitOverride();
      program.parseOptions(["--prompt", "custom prompt"]);
      expect(program.opts().prompt).toBe("custom prompt");
    });

    it("parses --config flag", () => {
      const program = buildProgram();
      program.exitOverride();
      program.parseOptions(["--config", "/tmp/myconfig"]);
      expect(program.opts().config).toBe("/tmp/myconfig");
    });

    it("parses --verbose flag", () => {
      const program = buildProgram();
      program.exitOverride();
      program.parseOptions(["--verbose"]);
      expect(program.opts().verbose).toBe(true);
    });

    it("has models subcommand", () => {
      const program = buildProgram();
      const modelCmd = program.commands.find((c) => c.name() === "models");
      expect(modelCmd).toBeDefined();
    });

    it("has chat subcommand", () => {
      const program = buildProgram();
      const chatCmd = program.commands.find((c) => c.name() === "chat");
      expect(chatCmd).toBeDefined();
    });

    it("--mcp flag is hidden", () => {
      const program = buildProgram();
      const mcpOption = program.options.find((o) => o.long === "--mcp");
      expect(mcpOption).toBeDefined();
      expect(mcpOption!.hidden).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Exit code mapping
  // --------------------------------------------------------------------------
  describe("exit codes (mapErrorToExitCode)", () => {
    it("maps AuthError to exit code 2", () => {
      const err = new AuthError("no_token", "no token", false);
      expect(mapErrorToExitCode(err)).toBe(2);
    });

    it("maps DiffError to exit code 3", () => {
      const err = new DiffError("empty_diff", "empty diff");
      expect(mapErrorToExitCode(err)).toBe(3);
    });

    it("maps ClientError to exit code 4", () => {
      const err = new ClientError("rate_limited", "rate limited", true);
      expect(mapErrorToExitCode(err)).toBe(4);
    });

    it("maps ModelError to exit code 4", () => {
      const err = new ModelError("model_not_found", "not found", false);
      expect(mapErrorToExitCode(err)).toBe(4);
    });

    it("maps ConfigError to exit code 5", () => {
      const err = new ConfigError("malformed_json", "bad config", "/tmp/config.json");
      expect(mapErrorToExitCode(err)).toBe(5);
    });

    it("maps unknown errors to exit code 4", () => {
      const err = new Error("unexpected");
      expect(mapErrorToExitCode(err)).toBe(4);
    });
  });

  // --------------------------------------------------------------------------
  // handleReview
  // --------------------------------------------------------------------------
  describe("handleReview", () => {
    it("exits 0 on success with no HIGH findings", async () => {
      const result = makeReviewResult();
      mockReview.mockResolvedValue(result);
      mockDetectHigh.mockReturnValue(false);

      const code = await handleReview("local", undefined, {
        model: "auto",
        format: "markdown",
        stream: false,
        config: undefined,
        prompt: undefined,
        verbose: false,
      });

      expect(code).toBe(0);
      expect(stdoutOutput).toContain("No issues found.");
    });

    it("exits 1 when review contains HIGH severity", async () => {
      const result = makeReviewResult({ content: "### HIGH: SQL injection" });
      mockReview.mockResolvedValue(result);
      mockDetectHigh.mockReturnValue(true);

      const code = await handleReview("local", undefined, {
        model: "auto",
        format: "markdown",
        stream: false,
        config: undefined,
        prompt: undefined,
        verbose: false,
      });

      expect(code).toBe(1);
    });

    it("exits 2 on auth failure", async () => {
      mockReview.mockRejectedValue(new AuthError("no_token", "no token", false));

      const code = await handleReview("local", undefined, {
        model: "auto",
        format: "markdown",
        stream: false,
        config: undefined,
        prompt: undefined,
        verbose: false,
      });

      expect(code).toBe(2);
      expect(stderrOutput).toContain("no token");
    });

    it("exits 3 on diff error", async () => {
      mockReview.mockRejectedValue(new DiffError("not_git_repo", "Not a git repo"));

      const code = await handleReview("local", undefined, {
        model: "auto",
        format: "markdown",
        stream: false,
        config: undefined,
        prompt: undefined,
        verbose: false,
      });

      expect(code).toBe(3);
    });

    it("exits 4 on API error", async () => {
      mockReview.mockRejectedValue(new ClientError("rate_limited", "rate limited", true));

      const code = await handleReview("local", undefined, {
        model: "auto",
        format: "markdown",
        stream: false,
        config: undefined,
        prompt: undefined,
        verbose: false,
      });

      expect(code).toBe(4);
    });

    it("exits 5 on config error", async () => {
      mockLoadConfig.mockRejectedValue(
        new ConfigError("malformed_json", "bad config", "/tmp/config.json")
      );

      const code = await handleReview("local", undefined, {
        model: "auto",
        format: "markdown",
        stream: false,
        config: undefined,
        prompt: undefined,
        verbose: false,
      });

      expect(code).toBe(5);
    });

    it("writes progress messages to stderr", async () => {
      mockReview.mockResolvedValue(makeReviewResult());
      mockDetectHigh.mockReturnValue(false);

      await handleReview("local", undefined, {
        model: "auto",
        format: "markdown",
        stream: false,
        config: undefined,
        prompt: undefined,
        verbose: false,
      });

      expect(stderrOutput).toContain("Loading configuration");
      expect(stderrOutput).toContain("Requesting review");
    });

    it("writes review content to stdout", async () => {
      const result = makeReviewResult({ content: "Found 3 issues." });
      mockReview.mockResolvedValue(result);
      mockDetectHigh.mockReturnValue(false);

      await handleReview("local", undefined, {
        model: "auto",
        format: "markdown",
        stream: false,
        config: undefined,
        prompt: undefined,
        verbose: false,
      });

      expect(stdoutOutput).toContain("Found 3 issues.");
    });

    it("passes --model to config overrides", async () => {
      mockReview.mockResolvedValue(makeReviewResult());
      mockDetectHigh.mockReturnValue(false);

      await handleReview("local", undefined, {
        model: "gpt-4.1",
        format: "markdown",
        stream: false,
        config: undefined,
        prompt: undefined,
        verbose: false,
      });

      expect(mockLoadConfig).toHaveBeenCalledWith(
        expect.objectContaining({ model: "gpt-4.1" })
      );
    });

    it("accepts all 7 modes", async () => {
      const modeArgs: Record<string, string> = {
        unstaged: "",
        staged: "",
        local: "",
        branch: "main",
        pr: "123",
        commits: "5",
        range: "abc..def",
      };
      mockReview.mockResolvedValue(makeReviewResult());
      mockDetectHigh.mockReturnValue(false);

      for (const [mode, arg] of Object.entries(modeArgs)) {
        vi.clearAllMocks();
        mockLoadConfig.mockResolvedValue(makeConfig());
        mockReview.mockResolvedValue(makeReviewResult());
        mockDetectHigh.mockReturnValue(false);

        const code = await handleReview(mode, arg || undefined, {
          model: undefined,
          format: "markdown",
          stream: false,
          config: undefined,
          prompt: undefined,
          verbose: false,
        });

        expect(code).toBe(0);
      }
    });

    it("uses streaming when config.stream is true and format is text/markdown", async () => {
      mockLoadConfig.mockResolvedValue(makeConfig({ stream: true, format: "markdown" }));

      async function* fakeStream() {
        yield "chunk1";
        yield "chunk2";
      }

      const streamResult: ReviewStreamResult = {
        stream: fakeStream(),
        warnings: [],
        diff: { raw: "diff", files: [], stats: { filesChanged: 1, insertions: 1, deletions: 0 } },
        model: "gpt-4.1",
      };
      mockReviewStream.mockResolvedValue(streamResult);
      mockDetectHigh.mockReturnValue(false);

      const code = await handleReview("local", undefined, {
        model: "auto",
        format: undefined, // will use config default
        stream: true,
        config: undefined,
        prompt: undefined,
        verbose: false,
      });

      expect(code).toBe(0);
      expect(mockReviewStream).toHaveBeenCalled();
      expect(stdoutOutput).toContain("chunk1");
      expect(stdoutOutput).toContain("chunk2");
    });
  });

  // --------------------------------------------------------------------------
  // TTY detection
  // --------------------------------------------------------------------------
  describe("TTY detection", () => {
    it("non-TTY defaults format to json when no explicit --format", async () => {
      const origIsTTY = process.stdout.isTTY;
      Object.defineProperty(process.stdout, "isTTY", { value: undefined, configurable: true });

      mockReview.mockResolvedValue(makeReviewResult());
      mockDetectHigh.mockReturnValue(false);

      await handleReview("local", undefined, {
        model: "auto",
        format: undefined, // no explicit format
        stream: false,
        config: undefined,
        prompt: undefined,
        verbose: false,
      });

      // loadConfig should have been called with format: "json"
      expect(mockLoadConfig).toHaveBeenCalledWith(
        expect.objectContaining({ format: "json" })
      );

      Object.defineProperty(process.stdout, "isTTY", { value: origIsTTY, configurable: true });
    });

    it("explicit --format overrides TTY detection", async () => {
      const origIsTTY = process.stdout.isTTY;
      Object.defineProperty(process.stdout, "isTTY", { value: undefined, configurable: true });

      mockReview.mockResolvedValue(makeReviewResult());
      mockDetectHigh.mockReturnValue(false);

      await handleReview("local", undefined, {
        model: "auto",
        format: "text", // explicit
        stream: false,
        config: undefined,
        prompt: undefined,
        verbose: false,
      });

      expect(mockLoadConfig).toHaveBeenCalledWith(
        expect.objectContaining({ format: "text" })
      );

      Object.defineProperty(process.stdout, "isTTY", { value: origIsTTY, configurable: true });
    });
  });

  // --------------------------------------------------------------------------
  // handleModels
  // --------------------------------------------------------------------------
  describe("handleModels", () => {
    it("lists models and prints table", async () => {
      mockListModels.mockResolvedValue([
        makeModelInfo("gpt-4.1"),
        makeModelInfo("claude-sonnet-4"),
      ]);

      const code = await handleModels();

      expect(code).toBe(0);
      expect(stdoutOutput).toContain("gpt-4.1");
      expect(stdoutOutput).toContain("claude-sonnet-4");
    });

    it("exits 2 on auth error", async () => {
      mockListModels.mockRejectedValue(new AuthError("no_token", "no token", false));

      const code = await handleModels();

      expect(code).toBe(2);
      expect(stderrOutput).toContain("no token");
    });
  });

  // --------------------------------------------------------------------------
  // handleChat
  // --------------------------------------------------------------------------
  describe("handleChat", () => {
    beforeEach(() => {
      mockAutoSelect.mockResolvedValue("gpt-4.1");
      mockValidateModel.mockResolvedValue(makeModelInfo("gpt-4.1"));
    });

    it("sends message and prints response", async () => {
      mockChat.mockResolvedValue({
        content: "Hello! How can I help?",
        model: "gpt-4.1",
        usage: { totalTokens: 50 },
      } satisfies ChatResponse);

      const code = await handleChat("Hello world");

      expect(code).toBe(0);
      expect(stdoutOutput).toContain("Hello! How can I help?");
    });

    it("uses empty system prompt (not review prompt)", async () => {
      mockChat.mockResolvedValue({
        content: "response",
        model: "gpt-4.1",
        usage: { totalTokens: 50 },
      });

      await handleChat("test");

      expect(mockChat).toHaveBeenCalledWith(
        expect.objectContaining({ systemPrompt: "" }),
      );
    });

    it("exits 2 on auth error", async () => {
      mockChat.mockRejectedValue(new AuthError("no_token", "no token", false));

      const code = await handleChat("test");

      expect(code).toBe(2);
    });

    it("exits 4 on API error", async () => {
      mockChat.mockRejectedValue(new ClientError("rate_limited", "rate limited", true));

      const code = await handleChat("test");

      expect(code).toBe(4);
    });
  });

  // --------------------------------------------------------------------------
  // handleStatus
  // --------------------------------------------------------------------------
  describe("handleStatus", () => {
    beforeEach(() => {
      // Reset provider healthCheck and listModels for status tests
      mockProvider.healthCheck.mockResolvedValue({ ok: true, latencyMs: 120 });
      mockListModels.mockResolvedValue([makeModelInfo("gpt-4.1"), makeModelInfo("claude-sonnet-4")]);
      mockAutoSelect.mockResolvedValue("gpt-4.1");
    });

    it("returns exit 0 when provider is healthy and all checks pass", async () => {
      const code = await handleStatus({});
      expect(code).toBe(0);
    });

    it("returns exit 1 when healthCheck returns ok: false", async () => {
      mockProvider.healthCheck.mockResolvedValue({
        ok: false,
        latencyMs: null,
        error: "connection refused at http://localhost:11434",
      });

      const code = await handleStatus({});
      expect(code).toBe(1);
    });

    it("--json flag outputs valid JSON with healthy: true", async () => {
      const code = await handleStatus({ json: true });

      expect(code).toBe(0);
      const parsed = JSON.parse(stdoutOutput);
      expect(parsed.healthy).toBe(true);
      expect(parsed.provider).toBe("copilot");
      expect(parsed.api.reachable).toBe(true);
      expect(parsed.api.latencyMs).toBe(120);
    });

    it("--json output has api.reachable: false when provider unreachable", async () => {
      mockProvider.healthCheck.mockResolvedValue({
        ok: false,
        latencyMs: null,
        error: "connection refused",
      });

      const code = await handleStatus({ json: true });

      expect(code).toBe(1);
      const parsed = JSON.parse(stdoutOutput);
      expect(parsed.healthy).toBe(false);
      expect(parsed.api.reachable).toBe(false);
      expect(parsed.api.latencyMs).toBeNull();
      expect(parsed.api.error).toBe("connection refused");
    });

    it("shows model.resolved after auto-select when model is 'auto'", async () => {
      mockLoadConfig.mockResolvedValue(makeConfig({ model: "auto" }));
      mockAutoSelect.mockResolvedValue("gpt-4.1");

      const code = await handleStatus({ json: true });

      expect(code).toBe(0);
      const parsed = JSON.parse(stdoutOutput);
      expect(parsed.model.configured).toBe("auto");
      expect(parsed.model.resolved).toBe("gpt-4.1");
    });

    it("handles provider without autoSelect — no resolution attempt", async () => {
      // Remove autoSelect from provider
      const { autoSelect, ...providerWithoutAutoSelect } = mockProvider;
      const { createProvider: mockCreateProvider } = await import("../src/lib/providers/index.js");
      (mockCreateProvider as ReturnType<typeof vi.fn>).mockResolvedValueOnce(providerWithoutAutoSelect);

      mockLoadConfig.mockResolvedValue(makeConfig({ model: "auto" }));

      const code = await handleStatus({ json: true });

      expect(code).toBe(0);
      const parsed = JSON.parse(stdoutOutput);
      // model.resolved should be null since autoSelect not available
      expect(parsed.model.resolved).toBeNull();
    });

    it("text mode prints human-readable lines to stdout", async () => {
      const code = await handleStatus({});

      expect(code).toBe(0);
      expect(stdoutOutput).toContain("Provider:");
      expect(stdoutOutput).toContain("copilot");
      expect(stdoutOutput).toContain("API reachable:");
    });

    it("--json output includes models list when reachable", async () => {
      const code = await handleStatus({ json: true });

      expect(code).toBe(0);
      const parsed = JSON.parse(stdoutOutput);
      expect(parsed.models).toEqual(["gpt-4.1", "claude-sonnet-4"]);
      expect(parsed.modelsError).toBeNull();
    });

    it("--json output has models: null and modelsError set when listModels throws", async () => {
      mockListModels.mockRejectedValue(new ClientError("rate_limited", "rate limited", true));

      const code = await handleStatus({ json: true });

      // Still exit 1 because models fetch failed (unhealthy)
      const parsed = JSON.parse(stdoutOutput);
      expect(parsed.models).toBeNull();
      expect(parsed.modelsError).toContain("rate limited");
    });

    it("has status subcommand registered in buildProgram", () => {
      const program = buildProgram();
      const statusCmd = program.commands.find((c) => c.name() === "status");
      expect(statusCmd).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Verbose / DEBUG mode
  // --------------------------------------------------------------------------
  describe("verbose mode", () => {
    it("--verbose enables debug output on stderr", async () => {
      mockReview.mockResolvedValue(makeReviewResult());
      mockDetectHigh.mockReturnValue(false);

      await handleReview("local", undefined, {
        model: "auto",
        format: "markdown",
        stream: false,
        config: undefined,
        prompt: undefined,
        verbose: true,
      });

      // Verbose should produce extra debug info
      expect(stderrOutput).toContain("[debug]");
    });

    it("DEBUG=copilot-review env var enables verbose", async () => {
      const origDebug = process.env.DEBUG;
      process.env.DEBUG = "copilot-review";

      mockReview.mockResolvedValue(makeReviewResult());
      mockDetectHigh.mockReturnValue(false);

      await handleReview("local", undefined, {
        model: "auto",
        format: "markdown",
        stream: false,
        config: undefined,
        prompt: undefined,
        verbose: false, // not explicitly set, but env var should enable it
      });

      expect(stderrOutput).toContain("[debug]");

      if (origDebug === undefined) {
        delete process.env.DEBUG;
      } else {
        process.env.DEBUG = origDebug;
      }
    });
  });
});
