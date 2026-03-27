// test/lib/streaming.test.ts

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { join } from "node:path";
import {
  parseSSEStream,
  parseChatCompletionChunk,
  parseResponsesChunk,
} from "../../src/lib/streaming.js";

/**
 * Helper to convert fixture text to ReadableStream
 */
function fixtureToStream(fixturePath: string): ReadableStream {
  const text = readFileSync(fixturePath, "utf-8");
  const readable = Readable.from([new TextEncoder().encode(text)]);
  return Readable.toWeb(readable) as ReadableStream;
}

describe("parseSSEStream", () => {
  it("yields parsed JSON objects from SSE data lines", async () => {
    const fixturePath = join(
      __dirname,
      "../fixtures/responses/chat-completions-streaming.txt"
    );
    const stream = fixtureToStream(fixturePath);
    const chunks: object[] = [];

    for await (const chunk of parseSSEStream(stream)) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual({
      choices: [{ delta: { content: "Hello" }, finish_reason: null }],
    });
    expect(chunks[1]).toEqual({
      choices: [{ delta: { content: " world" }, finish_reason: null }],
    });
    expect(chunks[2]).toEqual({
      choices: [{ finish_reason: "stop" }],
      usage: { total_tokens: 150 },
      model: "gpt-4.1",
    });
  });

  it("handles data: [DONE] as stream termination", async () => {
    const fixturePath = join(
      __dirname,
      "../fixtures/responses/chat-completions-streaming.txt"
    );
    const stream = fixtureToStream(fixturePath);
    const chunks: object[] = [];

    for await (const chunk of parseSSEStream(stream)) {
      chunks.push(chunk);
    }

    // [DONE] should terminate the stream, not be yielded as a chunk
    expect(chunks).toHaveLength(3);
    expect(chunks.every((c) => c !== "[DONE]")).toBe(true);
  });

  it("skips empty lines and comment lines", async () => {
    // Create a stream with empty lines and comments
    const text = `
data: {"test":1}

: comment line
data: {"test":2}

data: [DONE]
`;
    const readable = Readable.from([new TextEncoder().encode(text)]);
    const stream = Readable.toWeb(readable) as ReadableStream;
    const chunks: object[] = [];

    for await (const chunk of parseSSEStream(stream)) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual({ test: 1 });
    expect(chunks[1]).toEqual({ test: 2 });
  });

  it("parses reasoning stream from fixture end-to-end", async () => {
    const fixturePath = join(__dirname, "../fixtures/responses/chat-completions-reasoning.txt");
    const stream = fixtureToStream(fixturePath);
    const chunks: object[] = [];
    for await (const chunk of parseSSEStream(stream)) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(3);
    const parsed = chunks.map((c) => parseChatCompletionChunk(c));
    expect(parsed[0]).toEqual({ type: "reasoning", text: "Let me think..." });
    expect(parsed[1]).toEqual({ type: "content", text: "The answer is 42." });
    expect(parsed[2]?.type).toBe("done");
  });

  it("parses Responses API stream from fixture end-to-end", async () => {
    const fixturePath = join(__dirname, "../fixtures/responses/responses-api-streaming.txt");
    const stream = fixtureToStream(fixturePath);
    const chunks: object[] = [];
    for await (const chunk of parseSSEStream(stream)) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(3);
    const parsed = chunks.map((c) => parseResponsesChunk(c));
    expect(parsed[0]).toEqual({ type: "content", text: "Hello" });
    expect(parsed[1]).toEqual({ type: "content", text: " world" });
    expect(parsed[2]?.type).toBe("done");
  });

  it("parses Responses API delta-object fixture end-to-end", async () => {
    const fixturePath = join(__dirname, "../fixtures/responses/responses-api-delta-object.txt");
    const stream = fixtureToStream(fixturePath);
    const chunks: object[] = [];
    for await (const chunk of parseSSEStream(stream)) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(2);
    const parsed = chunks.map((c) => parseResponsesChunk(c));
    expect(parsed[0]).toEqual({ type: "content", text: "Hello object" });
    expect(parsed[1]?.type).toBe("done");
  });

  it("parses abnormal finish reasons from fixture", async () => {
    const fixturePath = join(__dirname, "../fixtures/responses/chat-completions-abnormal.txt");
    const stream = fixtureToStream(fixturePath);
    const chunks: object[] = [];
    for await (const chunk of parseSSEStream(stream)) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(2);
    const parsed = chunks.map((c) => parseChatCompletionChunk(c));
    expect(parsed[0]).toEqual({ type: "content", text: "partial" });
    expect(parsed[1]).toEqual({ type: "error", text: "content_filter" });
  });

  it("handles \\r\\n line endings", async () => {
    const text = "data: {\"test\":1}\r\ndata: {\"test\":2}\r\ndata: [DONE]\r\n";
    const readable = Readable.from([new TextEncoder().encode(text)]);
    const stream = Readable.toWeb(readable) as ReadableStream;
    const chunks: object[] = [];
    for await (const chunk of parseSSEStream(stream)) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(2);
  });

  it("handles empty stream", async () => {
    const readable = Readable.from([new TextEncoder().encode("")]);
    const stream = Readable.toWeb(readable) as ReadableStream;
    const chunks: object[] = [];
    for await (const chunk of parseSSEStream(stream)) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(0);
  });

  it("handles stream with only [DONE]", async () => {
    const text = "data: [DONE]\n";
    const readable = Readable.from([new TextEncoder().encode(text)]);
    const stream = Readable.toWeb(readable) as ReadableStream;
    const chunks: object[] = [];
    for await (const chunk of parseSSEStream(stream)) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(0);
  });

  it("skips malformed JSON lines gracefully", async () => {
    const text = `data: {"valid":1}
data: {malformed json
data: {"valid":2}
data: [DONE]
`;
    const readable = Readable.from([new TextEncoder().encode(text)]);
    const stream = Readable.toWeb(readable) as ReadableStream;
    const chunks: object[] = [];

    for await (const chunk of parseSSEStream(stream)) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual({ valid: 1 });
    expect(chunks[1]).toEqual({ valid: 2 });
  });
});

describe("parseChatCompletionChunk", () => {
  it("extracts delta.content as content chunk", () => {
    const chunk = {
      choices: [{ delta: { content: "Hello" }, finish_reason: null }],
    };
    const result = parseChatCompletionChunk(chunk);

    expect(result).toEqual({
      type: "content",
      text: "Hello",
    });
  });

  it("extracts delta.reasoning as reasoning chunk", () => {
    const chunk = {
      choices: [{ delta: { reasoning: "thinking..." }, finish_reason: null }],
    };
    const result = parseChatCompletionChunk(chunk);

    expect(result).toEqual({
      type: "reasoning",
      text: "thinking...",
    });
  });

  it("extracts delta.reasoning_content as reasoning chunk", () => {
    const chunk = {
      choices: [
        { delta: { reasoning_content: "Let me think..." }, finish_reason: null },
      ],
    };
    const result = parseChatCompletionChunk(chunk);

    expect(result).toEqual({
      type: "reasoning",
      text: "Let me think...",
    });
  });

  it("maps finish_reason stop to done chunk with usage", () => {
    const chunk = {
      choices: [{ finish_reason: "stop" }],
      usage: { total_tokens: 150 },
      model: "gpt-4.1",
    };
    const result = parseChatCompletionChunk(chunk);

    expect(result).toEqual({
      type: "done",
      usage: { totalTokens: 150 },
      model: "gpt-4.1",
    });
  });

  it("maps done_reason stop to done chunk (alternative field name)", () => {
    const chunk = {
      choices: [{ done_reason: "stop" }],
      usage: { total_tokens: 200 },
      model: "gpt-4.2",
    };
    const result = parseChatCompletionChunk(chunk);

    expect(result).toEqual({
      type: "done",
      usage: { totalTokens: 200 },
      model: "gpt-4.2",
    });
  });

  it("maps abnormal finish_reason to error chunk", () => {
    const chunk = {
      choices: [{ finish_reason: "content_filter" }],
    };
    const result = parseChatCompletionChunk(chunk);

    expect(result).toEqual({
      type: "error",
      text: "content_filter",
    });
  });

  it("ignores finish_reason tool_calls in v1", () => {
    const chunk = {
      choices: [{ finish_reason: "tool_calls" }],
    };
    const result = parseChatCompletionChunk(chunk);

    expect(result).toBeNull();
  });

  it("handles empty string delta.content (valid, not falsy)", () => {
    const chunk = {
      choices: [{ delta: { content: "" }, finish_reason: null }],
    };
    const result = parseChatCompletionChunk(chunk);
    expect(result).toEqual({ type: "content", text: "" });
  });

  it("returns null when choices array is empty", () => {
    const result = parseChatCompletionChunk({ choices: [] });
    expect(result).toBeNull();
  });

  it("returns null when choices is missing", () => {
    const result = parseChatCompletionChunk({});
    expect(result).toBeNull();
  });

  it("returns null for chunks with no actionable data", () => {
    const chunk = {
      choices: [{ delta: {} }],
    };
    const result = parseChatCompletionChunk(chunk);

    expect(result).toBeNull();
  });
});

describe("parseResponsesChunk", () => {
  it("extracts output_text.delta string as content chunk", () => {
    const chunk = {
      type: "response.output_text.delta",
      delta: "Hello",
    };
    const result = parseResponsesChunk(chunk);

    expect(result).toEqual({
      type: "content",
      text: "Hello",
    });
  });

  it("extracts output_text.delta object {text} as content chunk", () => {
    const chunk = {
      type: "response.output_text.delta",
      delta: { text: "Hello object" },
    };
    const result = parseResponsesChunk(chunk);

    expect(result).toEqual({
      type: "content",
      text: "Hello object",
    });
  });

  it("maps response.completed to done chunk with usage and model", () => {
    const chunk = {
      type: "response.completed",
      response: {
        status: "completed",
        usage: { total_tokens: 150 },
        model: "gpt-4.1",
      },
    };
    const result = parseResponsesChunk(chunk);

    expect(result).toEqual({
      type: "done",
      usage: { totalTokens: 150 },
      model: "gpt-4.1",
    });
  });

  it("maps response.done to done chunk", () => {
    const chunk = {
      type: "response.done",
      response: {
        usage: { total_tokens: 200 },
        model: "gpt-4.2",
      },
    };
    const result = parseResponsesChunk(chunk);

    expect(result).toEqual({
      type: "done",
      usage: { totalTokens: 200 },
      model: "gpt-4.2",
    });
  });

  it("maps response.failed to error chunk with message", () => {
    const chunk = {
      type: "response.failed",
      response: {
        error: {
          message: "Something went wrong",
        },
      },
    };
    const result = parseResponsesChunk(chunk);

    expect(result).toEqual({
      type: "error",
      text: "Something went wrong",
    });
  });

  it("handles empty string delta (valid, not falsy)", () => {
    const chunk = { type: "response.output_text.delta", delta: "" };
    const result = parseResponsesChunk(chunk);
    expect(result).toEqual({ type: "content", text: "" });
  });

  it("handles empty string in delta.text object (valid, not falsy)", () => {
    const chunk = { type: "response.output_text.delta", delta: { text: "" } };
    const result = parseResponsesChunk(chunk);
    expect(result).toEqual({ type: "content", text: "" });
  });

  it("returns null for chunks with no actionable data", () => {
    const chunk = {
      type: "unknown.type",
    };
    const result = parseResponsesChunk(chunk);

    expect(result).toBeNull();
  });
});
