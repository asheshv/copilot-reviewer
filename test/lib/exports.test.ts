// test/lib/exports.test.ts
import { describe, it, expect } from "vitest";
import * as lib from "../../src/lib/index.js";

describe("public API exports", () => {
  it("exports all types", () => {
    // Error classes
    expect(lib.CopilotReviewError).toBeDefined();
    expect(lib.AuthError).toBeDefined();
    expect(lib.DiffError).toBeDefined();
    expect(lib.ClientError).toBeDefined();
    expect(lib.ConfigError).toBeDefined();
    expect(lib.ModelError).toBeDefined();
    expect(lib.ReviewError).toBeDefined();
    expect(lib.ParameterError).toBeDefined();

    // Constants
    expect(lib.EXIT_CODES).toBeDefined();
  });

  it("exports auth functions", () => {
    expect(lib.createDefaultAuthProvider).toBeTypeOf("function");
    expect(lib.getAuthenticatedHeaders).toBeTypeOf("function");
    expect(lib.resolveToken).toBeTypeOf("function");
    expect(lib.exchangeSessionToken).toBeTypeOf("function");
    expect(lib.clearSessionCache).toBeTypeOf("function");
  });

  it("exports client classes", () => {
    expect(lib.CopilotClient).toBeDefined();
  });

  it("exports streaming functions", () => {
    expect(lib.parseSSEStream).toBeTypeOf("function");
    expect(lib.parseChatCompletionChunk).toBeTypeOf("function");
    expect(lib.parseResponsesChunk).toBeTypeOf("function");
  });

  it("exports model manager", () => {
    expect(lib.ModelManager).toBeDefined();
  });

  it("exports diff functions", () => {
    expect(lib.collectDiff).toBeTypeOf("function");
  });

  it("exports config functions", () => {
    expect(lib.loadConfig).toBeTypeOf("function");
  });

  it("exports prompt functions", () => {
    expect(lib.loadBuiltInPrompt).toBeTypeOf("function");
    expect(lib.assembleUserMessage).toBeTypeOf("function");
  });

  it("exports formatter functions", () => {
    expect(lib.format).toBeTypeOf("function");
    expect(lib.formatNdjsonChunk).toBeTypeOf("function");
    expect(lib.detectHighSeverity).toBeTypeOf("function");
  });

  it("exports review functions", () => {
    expect(lib.review).toBeTypeOf("function");
    expect(lib.reviewStream).toBeTypeOf("function");
  });
});
