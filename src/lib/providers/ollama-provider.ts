// src/lib/providers/ollama-provider.ts

import type { ModelInfo } from "../types.js";
import { ClientError, ConfigError } from "../types.js";
import { OpenAIChatProvider } from "./openai-chat-provider.js";

const CACHE_TTL_MS = 300_000; // 5 minutes
const DEFAULT_CONTEXT_LENGTH = 4096;
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/**
 * OllamaProvider targets local Ollama LLMs via the OpenAI-compatible API.
 *
 * URL routing:
 *   - Chat completions → <ollamaRoot>/v1/chat/completions
 *     (achieved by passing `<ollamaRoot>/v1` as baseUrl to the parent class)
 *   - Health checks and model discovery → <ollamaRoot>/api/tags, /api/show
 *     (uses the stored ollamaRoot directly, not the /v1-suffixed baseUrl)
 */
export class OllamaProvider extends OpenAIChatProvider {
  readonly name = "ollama";

  /** Original root without /v1 — used for /api/tags and /api/show endpoints. */
  private readonly ollamaRoot: string;

  private _ollamaInitialized = false;

  // Model list cache
  private _cache: ModelInfo[] | null = null;
  private _cacheExpiry = 0;
  private _inflight: Promise<ModelInfo[]> | null = null;

  constructor(baseUrl = "http://localhost:11434", timeoutSeconds?: number) {
    // Validate and normalize URL before calling super()
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new ConfigError(
        "invalid_url",
        `Invalid Ollama base URL '${baseUrl}'. Expected format: http://host:port`,
        baseUrl,
        false
      );
    }

    if (parsed.pathname !== "/" && parsed.pathname !== "") {
      throw new ConfigError(
        "invalid_url",
        `Ollama base URL must not include a path (got '${parsed.pathname}'). Use the root URL, e.g., http://localhost:11434`,
        baseUrl,
        false
      );
    }

    if (parsed.search || parsed.hash) {
      throw new ConfigError(
        "invalid_url",
        `Ollama base URL must not include query parameters or fragments. Remove '${parsed.search}${parsed.hash}'`,
        baseUrl,
        false
      );
    }

    // Store root before super() call — needed for health/model endpoints.
    // Note: super() must be the first statement, so we store via a workaround:
    // We pass the /v1 URL to super, and compute ollamaRoot from parsed after.
    const root = `${parsed.protocol}//${parsed.host}`;
    super(`${root}/v1`, timeoutSeconds);
    this.ollamaRoot = root;
  }

  /**
   * No auth required for local Ollama.
   */
  protected async getHeaders(): Promise<Record<string, string>> {
    return {};
  }

  /**
   * Check Ollama reachability before marking initialized.
   */
  override async initialize(): Promise<void> {
    await super.initialize(); // idempotency check — returns early on second call
    if (this._ollamaInitialized) {
      return;
    }
    this._ollamaInitialized = true;
    const health = await this.healthCheck();
    if (!health.ok) {
      throw new ClientError(
        "provider_unavailable",
        `Cannot reach Ollama at ${this.ollamaRoot}. Is Ollama running? Start it with 'ollama serve'. Error: ${health.error}`,
        false
      );
    }
  }

  /**
   * Health check using /api/tags (lighter than a full model fetch).
   * Must not throw.
   */
  override async healthCheck(): Promise<{ ok: boolean; latencyMs: number | null; error?: string }> {
    const start = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(`${this.ollamaRoot}/api/tags`, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const latencyMs = Date.now() - start;
      if (response.status === 401) {
        return { ok: false, latencyMs, error: "not_initialized" };
      }
      return {
        ok: response.ok,
        latencyMs,
        error: response.ok ? undefined : `HTTP ${response.status}`,
      };
    } catch (err) {
      clearTimeout(timeoutId);
      const isTimeout = err instanceof Error && err.name === "AbortError";
      return {
        ok: false,
        latencyMs: null,
        error: isTimeout ? "timeout" : (err instanceof Error ? err.message : String(err)),
      };
    }
  }

  /**
   * List models from Ollama.
   * Step 1: GET /api/tags for model names.
   * Step 2: POST /api/show per model to get context length.
   * Falls back to 4096 for individual /api/show failures.
   * Caches for 5 minutes; coalesces concurrent requests.
   */
  async listModels(): Promise<ModelInfo[]> {
    const now = Date.now();

    if (this._cache && this._cacheExpiry > now) {
      return this._cache;
    }

    // Coalesce concurrent callers onto the same in-flight promise
    if (this._inflight) {
      return this._inflight;
    }

    this._inflight = this._fetchModels().finally(() => {
      this._inflight = null;
    });

    return this._inflight;
  }

  private async _fetchModels(): Promise<ModelInfo[]> {
    // Step 1: GET /api/tags
    let tagsResponse: Response;
    try {
      tagsResponse = await fetch(`${this.ollamaRoot}/api/tags`);
    } catch (err) {
      throw new ClientError(
        "provider_unavailable",
        `Network error fetching Ollama models: ${err instanceof Error ? err.message : String(err)}`,
        true,
        err instanceof Error ? err : undefined
      );
    }

    if (!tagsResponse.ok) {
      const error = new ClientError(
        "request_failed",
        `Failed to fetch models from Ollama /api/tags (${tagsResponse.status}).`,
        false
      );
      error.status = tagsResponse.status;
      throw error;
    }

    const tagsJson = (await tagsResponse.json()) as { models?: Array<{ name: string }> };
    const rawModels = tagsJson.models ?? [];

    if (rawModels.length === 0) {
      this._cache = [];
      this._cacheExpiry = Date.now() + CACHE_TTL_MS;
      return [];
    }

    // Step 2: POST /api/show per model to get context length
    const models = await Promise.all(
      rawModels.map(m => this._enrichModel(m.name))
    );

    this._cache = models;
    this._cacheExpiry = Date.now() + CACHE_TTL_MS;

    return models;
  }

  /**
   * Fetch model details via /api/show. Falls back to DEFAULT_CONTEXT_LENGTH on failure.
   */
  private async _enrichModel(name: string): Promise<ModelInfo> {
    let numCtx = DEFAULT_CONTEXT_LENGTH;

    try {
      const response = await fetch(`${this.ollamaRoot}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });

      if (response.ok) {
        const json = (await response.json()) as { parameters?: string };
        const match = (json.parameters ?? "").match(/num_ctx\s+(\d+)/);
        if (match) {
          numCtx = parseInt(match[1], 10);
        }
      } else {
        process.stderr.write(
          `[ollama] Warning: /api/show failed for model '${name}' (${response.status}) — using ${DEFAULT_CONTEXT_LENGTH} default\n`
        );
      }
    } catch (err) {
      process.stderr.write(
        `[ollama] Warning: /api/show error for model '${name}': ${err instanceof Error ? err.message : String(err)} — using ${DEFAULT_CONTEXT_LENGTH} default\n`
      );
    }

    return {
      id: name,
      name,
      endpoints: ["/v1/chat/completions"],
      streaming: true,
      toolCalls: false,
      maxPromptTokens: numCtx,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      tokenizer: "unknown",
    };
  }

  /**
   * No-op — stateless provider.
   */
  override dispose(): void {
    // no-op
  }
}
