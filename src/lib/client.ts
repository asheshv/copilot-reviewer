// src/lib/client.ts

import type {
  AuthProvider,
  ChatRequest,
  ChatResponse,
  StreamChunk,
  Message,
} from "./types.js";
import { ClientError, AuthError } from "./types.js";
import {
  parseSSEStream,
  parseChatCompletionChunk,
  parseResponsesChunk,
} from "./streaming.js";

const BASE_URL = "https://api.githubcopilot.com";
const CONNECT_TIMEOUT = 10000; // 10 seconds
const OVERALL_TIMEOUT = 30000; // 30 seconds
const MAX_RETRIES = 2;
const BASE_BACKOFF = 1000; // 1 second
const MAX_BACKOFF = 10000; // 10 seconds

/**
 * Client for interacting with the GitHub Copilot API.
 * Supports both Chat Completions and Responses API formats.
 */
export class CopilotClient {
  constructor(private auth: AuthProvider) {}

  /**
   * Non-streaming chat completion.
   *
   * @param request - The chat request parameters
   * @param useResponsesApi - Whether to use Responses API endpoint (default: false)
   * @returns Promise of ChatResponse with content, model, and usage
   */
  async chat(
    request: ChatRequest,
    useResponsesApi = false
  ): Promise<ChatResponse> {
    return this._retry(async () => {
      const url = useResponsesApi
        ? `${BASE_URL}/responses`
        : `${BASE_URL}/chat/completions`;

      const body = useResponsesApi
        ? this._buildResponsesBody(request)
        : this._buildChatCompletionsBody(request);

      const headers = await this._buildHeaders();

      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        OVERALL_TIMEOUT
      );

      try {
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        // Handle HTTP errors
        if (!response.ok) {
          await this._handleErrorResponse(response);
        }

        const json = await response.json();

        return useResponsesApi
          ? this._parseResponsesApiResponse(json)
          : this._parseChatCompletionsResponse(json);
      } catch (error) {
        clearTimeout(timeoutId);

        // Re-throw if already a ClientError or AuthError
        if (
          error instanceof ClientError ||
          error instanceof AuthError
        ) {
          throw error;
        }

        // Handle network/timeout errors
        if (error instanceof Error) {
          if (error.name === "AbortError") {
            throw new ClientError(
              "timeout",
              `Request timed out after ${OVERALL_TIMEOUT}ms`,
              true,
              error
            );
          }

          throw new ClientError(
            "network_error",
            `Network error: ${error.message}`,
            true,
            error
          );
        }

        throw error;
      }
    });
  }

  /**
   * Streaming chat completion.
   *
   * @param request - The chat request parameters
   * @param useResponsesApi - Whether to use Responses API endpoint (default: false)
   * @returns AsyncIterable of StreamChunk
   */
  async *chatStream(
    request: ChatRequest,
    useResponsesApi = false
  ): AsyncIterable<StreamChunk> {
    const url = useResponsesApi
      ? `${BASE_URL}/responses`
      : `${BASE_URL}/chat/completions`;

    const body = useResponsesApi
      ? this._buildResponsesBody(request)
      : this._buildChatCompletionsBody(request);

    const headers = await this._buildHeaders();

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      OVERALL_TIMEOUT
    );

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        await this._handleErrorResponse(response);
      }

      if (!response.body) {
        throw new ClientError(
          "invalid_response",
          "Response body is null",
          false
        );
      }

      // Parse SSE stream and convert to StreamChunks
      const parser = useResponsesApi
        ? parseResponsesChunk
        : parseChatCompletionChunk;

      for await (const rawChunk of parseSSEStream(response.body)) {
        const chunk = parser(rawChunk);
        if (chunk) {
          yield chunk;
        }
      }
    } catch (error) {
      clearTimeout(timeoutId);

      if (
        error instanceof ClientError ||
        error instanceof AuthError
      ) {
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
   * Build request body for Chat Completions API.
   */
  private _buildChatCompletionsBody(request: ChatRequest): any {
    const isO1Model = request.model.startsWith("o1");
    const messages: Message[] = [];

    // Handle system prompt
    if (request.systemPrompt) {
      if (isO1Model) {
        // Demote system role to user for o1 models
        messages.push({
          role: "user",
          content: request.systemPrompt,
        });
      } else {
        messages.push({
          role: "system",
          content: request.systemPrompt,
        });
      }
    }

    // Add user messages
    messages.push(...request.messages);

    const body: any = {
      model: request.model,
      messages,
      stream: request.stream,
    };

    // Add maxTokens if specified
    if (request.maxTokens) {
      body.max_tokens = request.maxTokens;
    }

    // Omit temperature, n, top_p for o1 models
    if (!isO1Model) {
      body.temperature = 1;
      body.n = 1;
      body.top_p = 1;
    }

    return body;
  }

  /**
   * Build request body for Responses API.
   */
  private _buildResponsesBody(request: ChatRequest): any {
    const messages: Message[] = [];

    // For Responses API, always use system role
    if (request.systemPrompt) {
      messages.push({
        role: "system",
        content: request.systemPrompt,
      });
    }

    messages.push(...request.messages);

    const body: any = {
      model: request.model,
      messages,
      stream: request.stream,
    };

    if (request.maxTokens) {
      body.max_output_tokens = request.maxTokens;
    }

    return body;
  }

  /**
   * Parse Chat Completions API response.
   */
  private _parseChatCompletionsResponse(json: any): ChatResponse {
    const choice = json.choices?.[0];

    if (!choice) {
      throw new ClientError(
        "invalid_response",
        "Missing choices[0] in response",
        false
      );
    }

    const message = choice.message;
    if (!message?.content) {
      throw new ClientError(
        "invalid_response",
        "Missing message.content in response",
        false
      );
    }

    // Check both finish_reason and done_reason
    const finishReason = choice.finish_reason || choice.done_reason;
    if (finishReason && finishReason !== "stop") {
      throw new ClientError(
        "unexpected_finish",
        `Unexpected finish reason: ${finishReason}`,
        false
      );
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
   * Parse Responses API response.
   */
  private _parseResponsesApiResponse(json: any): ChatResponse {
    const response = json.response;

    if (!response) {
      throw new ClientError(
        "invalid_response",
        "Missing response object",
        false
      );
    }

    // Check status
    if (response.status === "failed") {
      const errorMessage =
        response.error?.message || "Request failed";
      throw new ClientError("api_error", errorMessage, false);
    }

    if (response.status !== "completed") {
      throw new ClientError(
        "invalid_response",
        `Unexpected status: ${response.status}`,
        false
      );
    }

    // Extract content from output
    const output = response.output?.[0];
    if (!output?.content) {
      throw new ClientError(
        "invalid_response",
        "Missing output content",
        false
      );
    }

    // Extract text from content array - filter by type
    const contentParts: string[] = [];
    for (const item of output.content) {
      if (
        item.type === "output_text" ||
        item.type === "text" ||
        item.type === "input_text"
      ) {
        contentParts.push(item.text || "");
      }
    }

    return {
      content: contentParts.join(""),
      model: response.model || "unknown",
      usage: {
        totalTokens: response.usage?.total_tokens || 0,
      },
    };
  }

  /**
   * Build headers for API requests.
   */
  private async _buildHeaders(): Promise<Record<string, string>> {
    const authHeaders = await this.auth.getAuthenticatedHeaders();

    return {
      ...authHeaders,
      "Editor-Version": "copilot-reviewer/0.1.0",
      "Editor-Plugin-Version": "copilot-reviewer/0.1.0",
      "Copilot-Integration-Id": "vscode-chat",
      "x-github-api-version": "2025-10-01",
      "Content-Type": "application/json",
    };
  }

  /**
   * Handle HTTP error responses.
   */
  private async _handleErrorResponse(response: Response): Promise<never> {
    let body: any;
    try {
      body = await response.json();
    } catch {
      body = {};
    }

    // 401 with authorize_url is an auth error
    if (response.status === 401) {
      const error = new AuthError(
        "unauthorized",
        body.error?.message || "Unauthorized",
        true
      );
      if (body.error?.authorize_url) {
        error.authorizeUrl = body.error.authorize_url;
      }
      throw error;
    }

    // Other errors
    const error = new ClientError(
      "api_error",
      body.error?.message || `HTTP ${response.status}`,
      false
    );
    error.status = response.status;

    // Extract retry-after if present
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) {
      error.retryAfter = parseInt(retryAfter, 10);
    }

    // Check for rate limit headers (secondary limits on 403)
    const rateLimitRemaining = response.headers.get("x-ratelimit-remaining");
    const rateLimitReset = response.headers.get("x-ratelimit-reset");
    if (rateLimitRemaining === "0" && rateLimitReset) {
      const resetTime = parseInt(rateLimitReset, 10);
      const now = Math.floor(Date.now() / 1000);
      error.retryAfter = Math.max(1, resetTime - now);
    }

    throw error;
  }

  /**
   * Retry wrapper with exponential backoff and jitter.
   */
  private async _retry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error as Error;

        // Don't retry on auth errors with authorize_url
        if (
          error instanceof AuthError &&
          error.authorizeUrl
        ) {
          throw error;
        }

        // Don't retry on non-recoverable errors
        if (
          error instanceof ClientError &&
          !this._shouldRetry(error)
        ) {
          throw error;
        }

        // No more retries available
        if (attempt === MAX_RETRIES) {
          throw error;
        }

        // Calculate backoff with jitter
        const backoff = this._calculateBackoff(
          attempt,
          error instanceof ClientError ? error : undefined
        );

        await this._sleep(backoff);
      }
    }

    throw lastError;
  }

  /**
   * Determine if error is retryable.
   */
  private _shouldRetry(error: ClientError): boolean {
    // Retry on timeout
    if (error.code === "timeout" || error.code === "network_error") {
      return true;
    }

    // Retry on 429
    if (error.status === 429) {
      return true;
    }

    // Retry on 502, 503, 504
    if (
      error.status === 502 ||
      error.status === 503 ||
      error.status === 504
    ) {
      return true;
    }

    // Retry on 403 with rate limit headers (secondary limits)
    if (error.status === 403 && error.retryAfter) {
      return true;
    }

    return false;
  }

  /**
   * Calculate backoff with jitter.
   */
  private _calculateBackoff(
    attempt: number,
    error?: ClientError
  ): number {
    // Honor retry-after header if present
    if (error?.retryAfter) {
      return error.retryAfter * 1000;
    }

    // Exponential backoff with jitter
    const exponential = Math.min(
      MAX_BACKOFF,
      BASE_BACKOFF * Math.pow(2, attempt)
    );
    const jitter = Math.random() * 0.5 + 0.5; // Random between 0.5 and 1.0

    return Math.floor(exponential * jitter);
  }

  /**
   * Sleep utility.
   */
  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
