// src/lib/streaming.ts

import type { StreamChunk } from "./types.js";
import { ClientError } from "./types.js";

/**
 * Parses a ReadableStream containing SSE (Server-Sent Events) formatted data.
 * Reads lines, extracts JSON from "data: " prefixed lines, and yields parsed objects.
 * Terminates when encountering "data: [DONE]".
 *
 * @param body - ReadableStream containing SSE data
 * @yields Parsed JSON objects from SSE data lines
 */
const MAX_LINE_BUFFER = 1024 * 1024; // 1MB max buffer to prevent DoS

export async function* parseSSEStream(
  body: ReadableStream
): AsyncIterable<object> {
  const reader = body.getReader();
  // Create decoder once for the entire stream (not per chunk) for performance
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      // Append new data to buffer
      buffer += decoder.decode(value, { stream: true });

      // Guard against unbounded buffer growth (malicious/malformed stream)
      if (buffer.length > MAX_LINE_BUFFER) {
        throw new ClientError(
          "stream_interrupted",
          "SSE buffer overflow: line exceeds 1MB limit",
          false
        );
      }

      // Process complete lines (handle both \n and \r\n)
      const lines = buffer.split(/\r?\n/);
      // Keep the last incomplete line in the buffer
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();

        // Skip empty lines
        if (!trimmed) {
          continue;
        }

        // Skip comment lines
        if (trimmed.startsWith(":")) {
          continue;
        }

        // Process data lines
        if (trimmed.startsWith("data: ")) {
          const data = trimmed.slice(6); // Remove "data: " prefix

          // Check for stream termination
          if (data === "[DONE]") {
            return;
          }

          // Parse JSON and yield
          try {
            const parsed = JSON.parse(data);
            yield parsed;
          } catch {
            // Skip malformed JSON gracefully
            continue;
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Parses a Chat Completions API SSE chunk into a normalized StreamChunk.
 *
 * Mappings:
 * - delta.content → { type: "content", text }
 * - delta.reasoning | delta.reasoning_content → { type: "reasoning", text }
 * - finish_reason: "stop" | done_reason: "stop" → { type: "done", usage, model }
 * - finish_reason: "tool_calls" → null (ignored in v1)
 * - Other finish_reason → { type: "error", text: finish_reason }
 *
 * @param chunk - Raw SSE chunk object from Chat Completions API
 * @returns Normalized StreamChunk or null if no actionable data
 */
export function parseChatCompletionChunk(chunk: any): StreamChunk | null {
  const choice = chunk.choices?.[0];
  if (!choice) {
    return null;
  }

  // Extract delta content (explicit null check — empty string is valid)
  if (choice.delta?.content != null) {
    return {
      type: "content",
      text: choice.delta.content,
    };
  }

  // Extract reasoning content
  if (choice.delta?.reasoning != null) {
    return {
      type: "reasoning",
      text: choice.delta.reasoning,
    };
  }

  if (choice.delta?.reasoning_content != null) {
    return {
      type: "reasoning",
      text: choice.delta.reasoning_content,
    };
  }

  // Check for completion (both finish_reason and done_reason)
  const finishReason = choice.finish_reason || choice.done_reason;

  if (finishReason === "stop") {
    return {
      type: "done",
      usage: chunk.usage?.total_tokens
        ? { totalTokens: chunk.usage.total_tokens }
        : undefined,
      model: chunk.model,
    };
  }

  // Ignore tool_calls in v1
  if (finishReason === "tool_calls") {
    return null;
  }

  // Map abnormal finish reasons to error
  if (finishReason) {
    return {
      type: "error",
      text: finishReason,
    };
  }

  // No actionable data
  return null;
}

/**
 * Parses a Responses API SSE chunk into a normalized StreamChunk.
 *
 * Mappings:
 * - response.output_text.delta (string or {text}) → { type: "content", text }
 * - response.completed | response.done → { type: "done", usage, model }
 * - response.failed → { type: "error", text: error.message }
 *
 * @param chunk - Raw SSE chunk object from Responses API
 * @returns Normalized StreamChunk or null if no actionable data
 */
export function parseResponsesChunk(chunk: any): StreamChunk | null {
  // Handle output_text.delta
  if (chunk.type === "response.output_text.delta") {
    const delta = chunk.delta;

    // Delta can be string or {text: "..."}
    if (typeof delta === "string") {
      return {
        type: "content",
        text: delta,
      };
    }

    if (delta?.text != null) {
      return {
        type: "content",
        text: delta.text,
      };
    }
  }

  // Handle response.completed
  if (chunk.type === "response.completed" || chunk.type === "response.done") {
    return {
      type: "done",
      usage: chunk.response?.usage?.total_tokens
        ? { totalTokens: chunk.response.usage.total_tokens }
        : undefined,
      model: chunk.response?.model,
    };
  }

  // Handle response.failed
  if (chunk.type === "response.failed") {
    return {
      type: "error",
      text: chunk.response?.error?.message,
    };
  }

  // No actionable data
  return null;
}
