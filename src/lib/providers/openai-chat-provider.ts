// src/lib/providers/openai-chat-provider.ts

import type {
  ChatRequest,
  ChatResponse,
  StreamChunk,
  ModelInfo,
  Message,
} from "../types.js";
import { ClientError, AuthError, ModelError } from "../types.js";
import {
  parseSSEStream,
  parseChatCompletionChunk,
} from "../streaming.js";
import type { ReviewProvider } from "./types.js";

const OVERALL_TIMEOUT = 30000; // 30 seconds
const MAX_RETRIES = 2;
const BASE_BACKOFF = 1000; // 1 second
const MAX_BACKOFF = 10000; // 10 seconds
const HEALTH_CHECK_TIMEOUT = 5000; // 5 seconds

/**
 * Abstract base class implementing the OpenAI-compatible Chat Completions protocol.
 * Handles request construction, response parsing, retries, and streaming.
 * Subclasses must implement `name`, `getHeaders()`, and `listModels()`.
 */
export abstract class OpenAIChatProvider implements ReviewProvider {
  abstract readonly name: string;

  private _initialized = false;

  constructor(protected baseUrl: string) {}

  /**
   * Return auth/custom headers. Content-Type is added by the base class.
   * Subclass-provided Content-Type is silently overridden.
   */
  abstract getHeaders(): Promise<Record<string, string>>;

  /** List available models on this provider. */
  abstract listModels(): Promise<ModelInfo[]>;

  /**
   * Idempotent initialization. Second call is a no-op.
   */
  async initialize(): Promise<void> {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
  }

  /**
   * No-op dispose. Subclasses may override to release resources.
   */
  dispose(): void {
    // no-op
  }

  /**
   * Health check: GET baseUrl with 5s timeout. Returns latency or error.
   * Must not throw.
   */
  async healthCheck(): Promise<{ ok: boolean; latencyMs: number | null; error?: string }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT);
    const start = Date.now();

    try {
      await fetch(`${this.baseUrl}/`, { signal: controller.signal });
      clearTimeout(timeoutId);
      return { ok: true, latencyMs: Date.now() - start };
    } catch (error) {
      clearTimeout(timeoutId);
      const message = error instanceof Error ? error.message : "unknown error";
      return { ok: false, latencyMs: null, error: message };
    }
  }

  /**
   * Validate that a model exists. Throws ModelError if not found.
   */
  async validateModel(id: string): Promise<ModelInfo> {
    const models = await this.listModels();
    const found = models.find(m => m.id === id);
    if (!found) {
      const available = models.map(m => m.id);
      const err = new ModelError(
        "model_not_found",
        `Model "${id}" not found. Available: ${available.join(", ")}`,
        false
      );
      err.available = available;
      throw err;
    }
    return found;
  }

  /**
   * Non-streaming chat completion.
   */
  async chat(request: ChatRequest): Promise<ChatResponse> {
    return this.retry(async () => {
      const body = this.buildRequestBody(request);
      const headers = await this._buildHeaders();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), OVERALL_TIMEOUT);

      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          await this.handleErrorResponse(response);
        }

        const json = await response.json();
        return this.parseResponse(json);
      } catch (error) {
        clearTimeout(timeoutId);

        if (error instanceof ClientError || error instanceof AuthError) {
          throw error;
        }

        if (error instanceof Error) {
          if (error.name === "AbortError") {
            throw new ClientError(
              "timeout",
              `Request timed out after ${OVERALL_TIMEOUT}ms`,
              true,
              error
            );
          }
          throw new ClientError("timeout", `Network error: ${error.message}`, true, error);
        }

        throw error;
      }
    });
  }

  /**
   * Streaming chat completion via SSE.
   * Pre-stream errors throw. Mid-stream errors yield { type: "error" } then stop.
   */
  async *chatStream(request: ChatRequest): AsyncIterable<StreamChunk> {
    const body = this.buildRequestBody(request);
    const headers = await this._buildHeaders();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OVERALL_TIMEOUT);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        await this.handleErrorResponse(response);
      }

      if (!response.body) {
        throw new ClientError("invalid_response", "Response body is null", false);
      }

      try {
        for await (const rawChunk of parseSSEStream(response.body)) {
          const chunk = parseChatCompletionChunk(rawChunk);
          if (chunk) {
            yield chunk;
            if (chunk.type === "error") {
              return; // MUST NOT yield more after error chunk
            }
          }
        }
      } catch (streamError) {
        if (streamError instanceof ClientError || streamError instanceof AuthError) {
          yield { type: "error", text: streamError.message };
          return;
        }
        if (streamError instanceof Error) {
          yield { type: "error", text: streamError.message };
          return;
        }
        yield { type: "error", text: "Unknown stream error" };
      }
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof ClientError || error instanceof AuthError) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new ClientError(
          "timeout",
          `Request timed out after ${OVERALL_TIMEOUT}ms`,
          true,
          error
        );
      }

      throw error;
    }
  }

  /**
   * Build request body for Chat Completions API. Handles o1 model quirks.
   */
  protected buildRequestBody(request: ChatRequest): any {
    const isO1Model = request.model.startsWith("o1");
    const messages: Message[] = [];

    if (request.systemPrompt) {
      if (isO1Model) {
        // o1 models don't support system role — demote to user
        messages.push({ role: "user", content: request.systemPrompt });
      } else {
        messages.push({ role: "system", content: request.systemPrompt });
      }
    }

    messages.push(...request.messages);

    const body: any = {
      model: request.model,
      messages,
      stream: request.stream,
    };

    if (request.maxTokens) {
      body.max_tokens = request.maxTokens;
    }

    if (!isO1Model) {
      body.temperature = 1;
      body.n = 1;
      body.top_p = 1;
    }

    return body;
  }

  /**
   * Parse Chat Completions API response into ChatResponse.
   */
  protected parseResponse(json: any): ChatResponse {
    const choice = json.choices?.[0];

    if (!choice) {
      throw new ClientError("invalid_response", "Missing choices[0] in response", false);
    }

    const message = choice.message;
    if (message?.content == null) {
      throw new ClientError("invalid_response", "Missing message.content in response", false);
    }

    return {
      content: message.content,
      model: json.model || "unknown",
      usage: {
        totalTokens: json.usage?.total_tokens || 0,
      },
    };
  }

  /**
   * Handle HTTP error responses. Always throws.
   */
  protected async handleErrorResponse(response: Response): Promise<never> {
    let body: any;
    try {
      body = await response.json();
    } catch {
      body = {};
    }

    if (response.status === 401) {
      const hasAuthorizeUrl = body.error?.authorize_url;
      const error = new AuthError(
        hasAuthorizeUrl ? "model_auth" : "request_failed",
        body.error?.message || "Unauthorized",
        false
      );
      if (hasAuthorizeUrl) {
        error.authorizeUrl = body.error.authorize_url;
      }
      throw error;
    }

    let errorCode: string;
    let recoverable: boolean;

    if (response.status === 429) {
      errorCode = "rate_limited";
      recoverable = true;
    } else if (
      response.status === 502 ||
      response.status === 503 ||
      response.status === 504
    ) {
      errorCode = "server_error";
      recoverable = true;
    } else {
      errorCode = "request_failed";
      recoverable = false;
    }

    const rateLimitReset = response.headers.get("x-ratelimit-reset");
    if (response.status === 403 && rateLimitReset) {
      errorCode = "rate_limited";
      recoverable = true;
    }

    const error = new ClientError(
      errorCode,
      body.error?.message || `HTTP ${response.status}`,
      recoverable
    );
    error.status = response.status;

    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) {
      error.retryAfter = parseInt(retryAfter, 10);
    }

    if (rateLimitReset && (response.status === 429 || response.status === 403)) {
      const resetTime = parseInt(rateLimitReset, 10);
      const now = Math.floor(Date.now() / 1000);
      error.retryAfter = Math.max(1, resetTime - now);
    }

    throw error;
  }

  /**
   * Retry wrapper with exponential backoff and jitter.
   */
  protected async retry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error as Error;

        if (error instanceof AuthError) {
          throw error;
        }

        if (error instanceof ClientError && !this.shouldRetry(error)) {
          throw error;
        }

        if (attempt === MAX_RETRIES) {
          throw error;
        }

        const backoff = this.calculateBackoff(
          attempt,
          error instanceof ClientError ? error : undefined
        );

        await this._sleep(backoff);
      }
    }

    throw lastError;
  }

  /**
   * Determine if a ClientError is retryable. Override in subclasses if needed.
   */
  protected shouldRetry(error: ClientError): boolean {
    return (
      error.code === "rate_limited" ||
      error.code === "server_error" ||
      error.code === "timeout"
    );
  }

  /**
   * Calculate backoff duration with jitter. Honors retry-after header.
   */
  protected calculateBackoff(attempt: number, error?: ClientError): number {
    if (error?.retryAfter) {
      return error.retryAfter * 1000;
    }

    const exponential = Math.min(MAX_BACKOFF, BASE_BACKOFF * Math.pow(2, attempt));
    const jitter = Math.random() * 1.0 + 0.5; // between 0.5 and 1.5

    return Math.floor(exponential * jitter);
  }

  /**
   * Build merged headers: subclass headers + Content-Type (base wins on Content-Type).
   */
  private async _buildHeaders(): Promise<Record<string, string>> {
    const subclassHeaders = await this.getHeaders();
    return {
      ...subclassHeaders,
      "Content-Type": "application/json", // always last — subclass cannot override
    };
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
