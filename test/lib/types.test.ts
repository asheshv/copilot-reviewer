// test/lib/types.test.ts
import { describe, it, expect } from "vitest";
import {
  CopilotReviewError, AuthError, DiffError, ClientError,
  ConfigError, ModelError, ReviewError, ParameterError,
} from "../../src/lib/types.js";

describe("CopilotReviewError", () => {
  it("extends Error with code, recoverable, and cause", () => {
    const cause = new Error("original");
    const err = new AuthError("no_token", "No token found", false, cause);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CopilotReviewError);
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
});

describe("DiffError", () => {
  it("creates with diff-specific codes and is not recoverable", () => {
    const err = new DiffError("empty_diff", "No changes found");
    expect(err.code).toBe("empty_diff");
    expect(err.recoverable).toBe(false);
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
});

describe("ConfigError", () => {
  it("requires filePath in constructor", () => {
    const err = new ConfigError("malformed_json", "Bad JSON", "~/.copilot-review/config.json");
    expect(err.filePath).toBe("~/.copilot-review/config.json");
    expect(err.code).toBe("malformed_json");
    expect(err.recoverable).toBe(false);
  });
});

describe("ModelError", () => {
  it("supports available model list", () => {
    const err = new ModelError("model_not_found", "Not found", false);
    err.available = ["gpt-4.1", "gpt-4o"];
    expect(err.available).toEqual(["gpt-4.1", "gpt-4o"]);
  });
});

describe("ReviewError", () => {
  it("supports suggestion field", () => {
    const err = new ReviewError("diff_too_large", "Too large", false);
    err.suggestion = "Use ignorePaths";
    expect(err.suggestion).toBe("Use ignorePaths");
  });
});

describe("ParameterError", () => {
  it("creates with parameter-specific codes", () => {
    const err = new ParameterError("missing_parameter", "Mode 'pr' requires 'pr' parameter");
    expect(err.code).toBe("missing_parameter");
    expect(err.recoverable).toBe(false);
  });
});
