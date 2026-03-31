// test/lib/providers/index.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ConfigError } from "../../../src/lib/types.js";
import type { ResolvedConfig } from "../../../src/lib/types.js";

// Mock CopilotProvider and createDefaultAuthProvider before importing index
vi.mock("../../../src/lib/providers/copilot-provider.js", () => {
  const mockInitialize = vi.fn().mockResolvedValue(undefined);
  const MockCopilotProvider = vi.fn().mockImplementation(() => ({
    name: "copilot",
    initialize: mockInitialize,
    chat: vi.fn(),
    chatStream: vi.fn(),
    listModels: vi.fn(),
    validateModel: vi.fn(),
    dispose: vi.fn(),
    healthCheck: vi.fn(),
  }));
  return { CopilotProvider: MockCopilotProvider };
});

vi.mock("../../../src/lib/auth.js", () => ({
  createDefaultAuthProvider: vi.fn().mockReturnValue({
    getAuthenticatedHeaders: vi.fn().mockResolvedValue({ Authorization: "Bearer mock-token" }),
  }),
}));

vi.mock("../../../src/lib/providers/ollama-provider.js", () => {
  const MockOllamaProvider = vi.fn().mockImplementation((baseUrl: string) => ({
    name: "ollama",
    _baseUrl: baseUrl,
    initialize: vi.fn().mockResolvedValue(undefined),
    chat: vi.fn(),
    chatStream: vi.fn(),
    listModels: vi.fn(),
    validateModel: vi.fn(),
    dispose: vi.fn(),
    healthCheck: vi.fn(),
  }));
  return { OllamaProvider: MockOllamaProvider };
});

// Import after mocks are set up
const { createProvider, availableProviders } = await import(
  "../../../src/lib/providers/index.js"
);
const { CopilotProvider } = await import(
  "../../../src/lib/providers/copilot-provider.js"
);
const { OllamaProvider } = await import(
  "../../../src/lib/providers/ollama-provider.js"
);

const baseConfig: ResolvedConfig = {
  model: "gpt-4o",
  format: "text",
  stream: false,
  prompt: "",
  defaultBase: "main",
  ignorePaths: [],
  provider: "copilot",
  providerOptions: {},
  chunking: "auto",
};

describe("createProvider", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns a CopilotProvider instance for provider=copilot", async () => {
    const provider = await createProvider({ ...baseConfig, provider: "copilot" });
    expect(CopilotProvider).toHaveBeenCalledTimes(1);
    expect(provider.initialize).toBeDefined();
    expect(provider.name).toBe("copilot");
  });

  it("calls initialize() on the created provider", async () => {
    const provider = await createProvider({ ...baseConfig, provider: "copilot" });
    expect(provider.initialize).toHaveBeenCalledTimes(1);
  });

  it("throws ConfigError with code unknown_provider for an unknown provider", async () => {
    await expect(
      createProvider({ ...baseConfig, provider: "unknown" })
    ).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof ConfigError)) return false;
      if (err.code !== "unknown_provider") return false;
      if (!err.message.includes("unknown")) return false;
      if (!err.message.includes("copilot")) return false;
      return true;
    });
  });

  it("wraps factory/initialize errors in ConfigError with code provider_init_failed", async () => {
    const initError = new Error("network failure");
    (CopilotProvider as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      name: "copilot",
      initialize: vi.fn().mockRejectedValue(initError),
      chat: vi.fn(),
      chatStream: vi.fn(),
      listModels: vi.fn(),
      validateModel: vi.fn(),
      dispose: vi.fn(),
      healthCheck: vi.fn(),
    }));

    await expect(
      createProvider({ ...baseConfig, provider: "copilot" })
    ).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof ConfigError)) return false;
      if (err.code !== "provider_init_failed") return false;
      if (!err.message.includes("network failure")) return false;
      return true;
    });
  });

  it("re-throws ConfigError from inside factory without double-wrapping", async () => {
    const inner = new ConfigError("inner_error", "inner message", "/some/path", false);
    (CopilotProvider as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      name: "copilot",
      initialize: vi.fn().mockRejectedValue(inner),
      chat: vi.fn(),
      chatStream: vi.fn(),
      listModels: vi.fn(),
      validateModel: vi.fn(),
      dispose: vi.fn(),
      healthCheck: vi.fn(),
    }));

    await expect(
      createProvider({ ...baseConfig, provider: "copilot" })
    ).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof ConfigError)) return false;
      // Must be exactly the inner error — same code, not wrapped
      if (err.code !== "inner_error") return false;
      if (err.message !== "inner message") return false;
      return true;
    });
  });
});

describe("availableProviders", () => {
  it("returns [\"copilot\", \"ollama\"]", () => {
    expect(availableProviders()).toEqual(["copilot", "ollama"]);
  });
});

describe("createProvider — ollama", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns an OllamaProvider instance for provider=ollama", async () => {
    const provider = await createProvider({ ...baseConfig, provider: "ollama" });
    expect(OllamaProvider).toHaveBeenCalledTimes(1);
    expect(provider.name).toBe("ollama");
  });

  it("uses the default URL http://localhost:11434 when no providerOptions given", async () => {
    await createProvider({ ...baseConfig, provider: "ollama", providerOptions: {} });
    expect(OllamaProvider).toHaveBeenCalledWith("http://localhost:11434", baseConfig.timeout);
  });

  it("uses the custom URL from providerOptions.ollama.baseUrl", async () => {
    await createProvider({
      ...baseConfig,
      provider: "ollama",
      providerOptions: { ollama: { baseUrl: "http://custom:1234" } },
    });
    expect(OllamaProvider).toHaveBeenCalledWith("http://custom:1234", baseConfig.timeout);
  });

  it("calls initialize() on the created OllamaProvider", async () => {
    const provider = await createProvider({ ...baseConfig, provider: "ollama" });
    expect(provider.initialize).toHaveBeenCalledTimes(1);
  });
});
