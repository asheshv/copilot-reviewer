// src/lib/providers/copilot-provider.ts

import type {
  AuthProvider,
  ChatRequest,
  ChatResponse,
  StreamChunk,
  ModelInfo,
} from "../types.js";
import { ClientError, ModelError } from "../types.js";
import {
  parseSSEStream,
  parseChatCompletionChunk,
  parseResponsesChunk,
} from "../streaming.js";
import { clearSessionCache } from "../auth.js";
import { OpenAIChatProvider } from "./openai-chat-provider.js";

const CACHE_TTL_MS = 300_000; // 5 minutes
const DEFAULT_TOKENIZER = "o200k_base";

/**
 * Raw model data from the Copilot API.
 */
interface RawModelData {
  id: string;
  name: string;
  version: string;
  model_picker_enabled?: boolean;
  capabilities?: {
    type: string;
    limits?: {
      max_prompt_tokens?: number;
      max_output_tokens?: number;
    };
  };
  endpoints?: string[];
  supported_endpoints?: string[];
  streaming?: boolean;
  tool_calls?: boolean;
  tokenizer?: string;
  policy?: {
    state: string;
  };
}

/**
 * CopilotProvider merges the Copilot-specific logic from client.ts and models.ts
 * into a single ReviewProvider implementation backed by OpenAIChatProvider.
 *
 * Routing logic:
 *   - If the model's endpoints include `/responses`, try the Responses API first.
 *   - On 404 or 400 from `/responses`, fall back to `/chat/completions` and
 *     mark the model so future calls skip `/responses` entirely.
 */
export class CopilotProvider extends OpenAIChatProvider {
  readonly name = "copilot";

  // Model list cache
  private _cache: ModelInfo[] | null = null;
  private _cacheExpiry = 0;

  // Per-model fallback flag: true means skip /responses for this model
  private _responsesFallback = new Map<string, boolean>();

  constructor(private auth: AuthProvider) {
    super("https://api.githubcopilot.com");
  }

  /**
   * Return Copilot-specific headers. Content-Type is intentionally omitted —
   * the base class adds it last (subclass cannot override Content-Type).
   */
  protected async getHeaders(): Promise<Record<string, string>> {
    const authHeaders = await this.auth.getAuthenticatedHeaders();
    return {
      ...authHeaders,
      "Editor-Version": "copilot-reviewer/0.1.0",
      "Editor-Plugin-Version": "copilot-reviewer/0.1.0",
      "Copilot-Integration-Id": "vscode-chat",
      "x-github-api-version": "2025-10-01",
    };
  }

  /**
   * Idempotent initialization. Calls getHeaders() once to validate auth eagerly.
   */
  async initialize(): Promise<void> {
    // Delegate to base class for idempotency check
    const wasInitialized = (this as any)._initialized as boolean;
    await super.initialize();
    if (!wasInitialized) {
      // Eagerly validate auth
      await this.getHeaders();
    }
  }

  /**
   * Zero out cached session token on dispose.
   */
  dispose(): void {
    clearSessionCache();
  }

  /**
   * Health check: GET /models with 5s timeout. Returns {ok, latencyMs, error?}.
   * Must not throw.
   */
  async healthCheck(): Promise<{ ok: boolean; latencyMs: number | null; error?: string }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const start = Date.now();

    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const latencyMs = Date.now() - start;
      return {
        ok: response.ok,
        latencyMs,
        error: response.ok ? undefined : `HTTP ${response.status}`,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      const message = error instanceof Error ? error.message : "unknown error";
      return { ok: false, latencyMs: null, error: message };
    }
  }

  /**
   * List available chat models.
   * Filters to chat-capable, picker-enabled models with valid token limits and endpoints.
   * Auto-enables disabled models. Deduplicates by name (highest version wins).
   * Caches for 5 minutes.
   */
  async listModels(): Promise<ModelInfo[]> {
    const now = Date.now();

    if (this._cache && this._cacheExpiry > now) {
      return this._cache;
    }

    const headers = await this._buildRequestHeaders();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/models`, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      throw new ClientError(
        "timeout",
        `Network error fetching models: ${err instanceof Error ? err.message : String(err)}`,
        true,
        err instanceof Error ? err : undefined
      );
    }
    clearTimeout(timeoutId);

    if (!response.ok) {
      const err = new ClientError(
        "request_failed",
        `Failed to fetch models from Copilot API (${response.status}).`,
        false
      );
      err.status = response.status;
      throw err;
    }

    const json = (await response.json()) as any;
    if (!json.data || !Array.isArray(json.data)) {
      throw new ClientError(
        "invalid_response",
        "Invalid response from /models endpoint: missing data array.",
        false
      );
    }

    const rawModels = json.data as RawModelData[];

    // Filter to chat-capable, picker-enabled, valid limits, has endpoints
    const filtered = rawModels.filter(m => {
      const isChat = m.capabilities?.type === "chat";
      const isSelectable = m.model_picker_enabled === true;
      const hasTokenLimits =
        (m.capabilities?.limits?.max_prompt_tokens ?? 0) > 0 &&
        (m.capabilities?.limits?.max_output_tokens ?? 0) > 0;
      const hasEndpoints = (m.endpoints ?? m.supported_endpoints ?? []).length > 0;
      return isChat && isSelectable && hasTokenLimits && hasEndpoints;
    });

    // Auto-enable disabled models (best-effort, parallel)
    await this._enableDisabledModels(filtered);

    // Deduplicate by name, keep highest version
    const deduplicated = this._deduplicateByVersion(filtered);

    // Transform to ModelInfo
    const models = deduplicated.map(m => this._transformToModelInfo(m));

    this._cache = models;
    this._cacheExpiry = now + CACHE_TTL_MS;

    return models;
  }

  /**
   * Auto-select a model using the Copilot API's /models/session endpoint.
   */
  async autoSelect(): Promise<string> {
    const headers = await this._buildRequestHeaders();
    const body = { auto_mode: { model_hints: ["auto"] } };

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/models/session`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new ModelError(
        "auto_select_failed",
        `Failed to auto-select model: ${error instanceof Error ? error.message : String(error)}`,
        false,
        error instanceof Error ? error : undefined
      );
    }

    if (!response.ok) {
      throw new ModelError(
        "auto_select_failed",
        `Failed to auto-select model: ${response.status} ${response.statusText}`,
        false
      );
    }

    const json = (await response.json()) as any;
    if (!json.selected_model || typeof json.selected_model !== "string") {
      throw new ModelError(
        "auto_select_failed",
        "Invalid response from auto-select API: missing selected_model",
        false
      );
    }

    return json.selected_model;
  }

  /**
   * Non-streaming chat with Responses API routing.
   */
  async chat(request: ChatRequest): Promise<ChatResponse> {
    const useResponses = await this._shouldUseResponsesApi(request.model);

    if (!useResponses) {
      return super.chat(request);
    }

    return this.retry(async () => {
      // If a previous attempt already marked this model for fallback, use base
      if (this._responsesFallback.get(request.model)) {
        return super.chat(request);
      }

      const headers = await this._buildRequestHeaders();
      const body = this._buildResponsesBody(request);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30_000);

      try {
        const response = await fetch(`${this.baseUrl}/responses`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        // Fallback trigger: 404 or 400 from /responses
        if (response.status === 404 || response.status === 400) {
          this._responsesFallback.set(request.model, true);
          return super.chat(request);
        }

        if (!response.ok) {
          await this.handleErrorResponse(response);
        }

        const json = await response.json();
        return this._parseResponsesApiResponse(json);
      } catch (error) {
        clearTimeout(timeoutId);

        if (error instanceof ClientError || (error as any)?.name === "AuthError") {
          throw error;
        }

        if (error instanceof Error) {
          if (error.name === "AbortError") {
            throw new ClientError(
              "timeout",
              `Request timed out after 30000ms`,
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
   * Streaming chat with Responses API routing.
   */
  async *chatStream(request: ChatRequest): AsyncIterable<StreamChunk> {
    const useResponses = await this._shouldUseResponsesApi(request.model);

    if (!useResponses || this._responsesFallback.get(request.model)) {
      yield* super.chatStream(request);
      return;
    }

    const headers = await this._buildRequestHeaders();
    const body = this._buildResponsesBody(request);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000);

    try {
      const response = await fetch(`${this.baseUrl}/responses`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Fallback trigger
      if (response.status === 404 || response.status === 400) {
        this._responsesFallback.set(request.model, true);
        yield* super.chatStream(request);
        return;
      }

      if (!response.ok) {
        await this.handleErrorResponse(response);
      }

      if (!response.body) {
        throw new ClientError("invalid_response", "Response body is null", false);
      }

      try {
        for await (const rawChunk of parseSSEStream(response.body)) {
          const chunk = parseResponsesChunk(rawChunk);
          if (chunk) {
            yield chunk;
            if (chunk.type === "error") {
              return;
            }
          }
        }
      } catch (streamError) {
        if (streamError instanceof ClientError || (streamError as any)?.name === "AuthError") {
          yield { type: "error", text: (streamError as Error).message };
          return;
        }
        if (streamError instanceof Error) {
          yield { type: "error", text: streamError.message };
          return;
        }
        yield { type: "error", text: "Unknown stream error" };
      } finally {
        clearTimeout(timeoutId);
        controller.abort();
      }
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof ClientError || (error as any)?.name === "AuthError") {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new ClientError("timeout", `Request timed out after 30000ms`, true, error);
      }

      throw error;
    }
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  /**
   * Build request headers including Content-Type (for non-base-class paths).
   */
  private async _buildRequestHeaders(): Promise<Record<string, string>> {
    const headers = await this.getHeaders();
    return { ...headers, "Content-Type": "application/json" };
  }

  /**
   * Determine if this model should try the Responses API first.
   * Uses cached model list if available; falls back to false if cache is empty.
   */
  private async _shouldUseResponsesApi(modelId: string): Promise<boolean> {
    if (this._responsesFallback.get(modelId)) {
      return false;
    }

    // Consult cached model list (don't force a fetch just for routing)
    if (this._cache) {
      const info = this._cache.find(m => m.id === modelId);
      if (info) {
        return info.endpoints.includes("/responses");
      }
    }

    return false;
  }

  /**
   * Build Responses API body.
   */
  private _buildResponsesBody(request: ChatRequest): any {
    const body: any = {
      model: request.model,
      stream: request.stream,
    };

    if (request.systemPrompt) {
      body.instructions = request.systemPrompt;
    }

    body.input = request.messages.map(m => ({
      role: m.role,
      content: m.content,
    }));

    if (request.maxTokens) {
      body.max_output_tokens = request.maxTokens;
    }

    return body;
  }

  /**
   * Parse Responses API non-streaming response.
   */
  private _parseResponsesApiResponse(json: any): ChatResponse {
    const response = json.response;

    if (!response) {
      throw new ClientError("invalid_response", "Missing response object", false);
    }

    if (response.status === "failed") {
      throw new ClientError(
        "request_failed",
        response.error?.message || "Request failed",
        false
      );
    }

    if (response.status !== "completed") {
      throw new ClientError(
        "invalid_response",
        `Unexpected status: ${response.status}`,
        false
      );
    }

    const output = response.output?.[0];
    if (!output?.content) {
      throw new ClientError("invalid_response", "Missing output content", false);
    }

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
      usage: { totalTokens: response.usage?.total_tokens || 0 },
    };
  }

  /**
   * Auto-enable models with a non-"enabled" policy state (best-effort, parallel).
   */
  private async _enableDisabledModels(models: RawModelData[]): Promise<void> {
    const disabled = models.filter(m => m.policy && m.policy.state !== "enabled");
    await Promise.allSettled(disabled.map(m => this._enablePolicy(m.id)));
  }

  private async _enablePolicy(id: string): Promise<void> {
    const headers = await this._buildRequestHeaders();
    const response = await fetch(`${this.baseUrl}/models/${id}/policy`, {
      method: "POST",
      headers,
      body: JSON.stringify({ state: "enabled" }),
    });

    if (!response.ok) {
      console.error(
        `Failed to enable policy for model ${id}: ${response.status} ${response.statusText}`
      );
    }
  }

  /**
   * Deduplicate models by name, keeping the highest version (lexicographic desc sort).
   */
  private _deduplicateByVersion(models: RawModelData[]): RawModelData[] {
    const grouped = new Map<string, RawModelData[]>();

    for (const model of models) {
      const existing = grouped.get(model.name) || [];
      existing.push(model);
      grouped.set(model.name, existing);
    }

    const result: RawModelData[] = [];
    for (const [, group] of grouped) {
      group.sort((a, b) => b.version.localeCompare(a.version));
      result.push(group[0]);
    }

    return result;
  }

  /**
   * Transform raw API model data to ModelInfo.
   */
  private _transformToModelInfo(raw: RawModelData): ModelInfo {
    if (!raw.id || !raw.name) {
      throw new ClientError(
        "invalid_response",
        `Model missing required fields: id=${raw.id}, name=${raw.name}`,
        false
      );
    }

    const endpoints = raw.endpoints ?? raw.supported_endpoints ?? [];
    if (endpoints.length === 0) {
      throw new ClientError(
        "invalid_response",
        `Model '${raw.id}' has no valid endpoints`,
        true
      );
    }

    return {
      id: raw.id,
      name: raw.name,
      endpoints,
      streaming: raw.streaming ?? false,
      toolCalls: raw.tool_calls ?? false,
      maxPromptTokens: raw.capabilities?.limits?.max_prompt_tokens ?? 0,
      maxOutputTokens: raw.capabilities?.limits?.max_output_tokens ?? 0,
      tokenizer: raw.tokenizer ?? DEFAULT_TOKENIZER,
    };
  }
}
