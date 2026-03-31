// test/lib/types.test.ts
import { describe, it, expect } from "vitest";
import {
  LlmReviewError, AuthError, DiffError, ClientError,
  ConfigError, ModelError, ReviewError, ParameterError,
  EXIT_CODES,
} from "../../src/lib/types.js";

describe("LlmReviewError", () => {
  it("extends Error with code, recoverable, and cause", () => {
    const cause = new Error("original");
    const err = new AuthError("no_token", "No token found", false, cause);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(LlmReviewError);
    expect(err).toBeInstanceOf(AuthError);
    expect(err.code).toBe("no_token");
    expect(err.message).toBe("No token found");
    expect(err.recoverable).toBe(false);
    expect(err.cause).toBe(cause);
    expect(err.name).toBe("AuthError");
  });
});

describe("AuthError", () => {
  it("supports authorizeUrl for model_auth code", () => {
    const err = new AuthError("model_auth", "Model needs auth", false);
    err.authorizeUrl = "https://github.com/authorize";
    expect(err.authorizeUrl).toBe("https://github.com/authorize");
  });

  it("is instanceof LlmReviewError and Error", () => {
    const err = new AuthError("no_token", "test", false);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(LlmReviewError);
    expect(err).toBeInstanceOf(AuthError);
    expect(err.name).toBe("AuthError");
  });
});

describe("DiffError", () => {
  it("creates with diff-specific codes and is not recoverable", () => {
    const err = new DiffError("empty_diff", "No changes found");
    expect(err.code).toBe("empty_diff");
    expect(err.recoverable).toBe(false);
  });

  it("is instanceof LlmReviewError and Error", () => {
    const err = new DiffError("test", "msg");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(LlmReviewError);
    expect(err).toBeInstanceOf(DiffError);
    expect(err.name).toBe("DiffError");
  });

  it("allows recoverable override (defaults false)", () => {
    const err1 = new DiffError("test", "msg");
    expect(err1.recoverable).toBe(false);
    const err2 = new DiffError("test", "msg", true);
    expect(err2.recoverable).toBe(true);
  });
});

describe("ClientError", () => {
  it("supports status and retryAfter for rate limiting", () => {
    const err = new ClientError("rate_limited", "Rate limited", true);
    err.status = 429;
    err.retryAfter = 30;
    expect(err.recoverable).toBe(true);
    expect(err.status).toBe(429);
    expect(err.retryAfter).toBe(30);
  });

  it("is instanceof LlmReviewError and Error", () => {
    const err = new ClientError("test", "msg", false);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(LlmReviewError);
    expect(err).toBeInstanceOf(ClientError);
    expect(err.name).toBe("ClientError");
  });
});

describe("ConfigError", () => {
  it("requires filePath in constructor", () => {
    const err = new ConfigError("malformed_json", "Bad JSON", "~/.llm-reviewer/config.json");
    expect(err.filePath).toBe("~/.llm-reviewer/config.json");
    expect(err.code).toBe("malformed_json");
    expect(err.recoverable).toBe(false);
  });

  it("is instanceof LlmReviewError and Error", () => {
    const err = new ConfigError("test", "msg", "/path");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(LlmReviewError);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.name).toBe("ConfigError");
  });
});

describe("ModelError", () => {
  it("supports available model list", () => {
    const err = new ModelError("model_not_found", "Not found", false);
    err.available = ["gpt-4.1", "gpt-4o"];
    expect(err.available).toEqual(["gpt-4.1", "gpt-4o"]);
  });

  it("is instanceof LlmReviewError and Error", () => {
    const err = new ModelError("test", "msg", false);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(LlmReviewError);
    expect(err).toBeInstanceOf(ModelError);
    expect(err.name).toBe("ModelError");
  });
});

describe("ReviewError", () => {
  it("supports suggestion field", () => {
    const err = new ReviewError("diff_too_large", "Too large", false);
    err.suggestion = "Use ignorePaths";
    expect(err.suggestion).toBe("Use ignorePaths");
  });

  it("is instanceof LlmReviewError and Error", () => {
    const err = new ReviewError("test", "msg", false);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(LlmReviewError);
    expect(err).toBeInstanceOf(ReviewError);
    expect(err.name).toBe("ReviewError");
  });
});

describe("ParameterError", () => {
  it("creates with parameter-specific codes", () => {
    const err = new ParameterError("missing_parameter", "Mode 'pr' requires 'pr' parameter");
    expect(err.code).toBe("missing_parameter");
    expect(err.recoverable).toBe(false);
  });

  it("is instanceof LlmReviewError and Error", () => {
    const err = new ParameterError("test", "msg");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(LlmReviewError);
    expect(err).toBeInstanceOf(ParameterError);
    expect(err.name).toBe("ParameterError");
  });

  it("allows recoverable override (defaults false)", () => {
    const err = new ParameterError("test", "msg", true);
    expect(err.recoverable).toBe(true);
  });
});

describe("EXIT_CODES", () => {
  it("defines all expected exit codes with correct values", () => {
    expect(EXIT_CODES).toEqual({
      SUCCESS: 0,
      HIGH_SEVERITY: 1,
      AUTH_ERROR: 2,
      DIFF_ERROR: 3,
      API_ERROR: 4,
      MODEL_ERROR: 4,
      CONFIG_ERROR: 5,
    });
  });
});
