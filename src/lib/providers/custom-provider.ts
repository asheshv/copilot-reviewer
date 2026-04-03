// src/lib/providers/custom-provider.ts

import type { ModelInfo, ChatRequest, ChatResponse, StreamChunk } from "../types.js";
import { ConfigError, ClientError } from "../types.js";
import { OpenAIChatProvider } from "./openai-chat-provider.js";

export interface CustomProviderAuth {
  apiKey?: string;
  apiKeyCommand?: string;
}

/**
 * Generic provider for any OpenAI-compatible endpoint.
 * Supports static API keys and dynamic key commands.
 */
export class CustomProvider extends OpenAIChatProvider {
  readonly name: string;

  private _auth: CustomProviderAuth;
  private _cachedKey: string | null = null;
  private _keyFetchPromise: Promise<string> | null = null;
  private _keyRefreshed = false;
  private _disposed = false;

  constructor(
    name: string,
    baseUrl: string,
    auth: CustomProviderAuth,
    timeoutSeconds?: number,
  ) {
    if (!baseUrl || baseUrl.trim() === "") {
      throw new ConfigError(
        "missing_base_url",
        `Custom provider '${name}' requires a base URL. Set it via --base-url, LLM_REVIEWER_BASE_URL env var, or providerOptions in config.`,
        "",
        false,
      );
    }
    super(baseUrl, timeoutSeconds);
    this.name = name;
    this._auth = auth;

    // Pre-cache static key only when no command is configured
    if (auth.apiKey && !auth.apiKeyCommand) {
      this._cachedKey = auth.apiKey;
    }
  }

  protected async getHeaders(): Promise<Record<string, string>> {
    if (this._disposed) {
      return {};
    }

    const key = await this._resolveKey();
    if (key) {
      return { Authorization: `Bearer ${key}` };
    }
    return {};
  }

  async listModels(): Promise<ModelInfo[]> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);
    try {
      const headers = await this.getHeaders();
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: { ...headers, "Content-Type": "application/json" },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        return [];
      }

      const json = (await response.json()) as { data?: Array<{ id: string }> };
      const rawModels = json.data ?? [];

      return rawModels.map((m) => ({
        id: m.id,
        name: m.id,
        endpoints: ["/v1/chat/completions"],
        streaming: true,
        toolCalls: false,
        maxPromptTokens: 128_000,
        maxOutputTokens: 4096,
        tokenizer: "unknown",
      }));
    } catch {
      clearTimeout(timeoutId);
      return [];
    }
  }

  /**
   * Override to intercept 401 (and 403 without rate-limit header) and attempt
   * key refresh before throwing.
   */
  protected override async handleErrorResponse(response: Response): Promise<never> {
    const isRateLimited = response.status === 403 && response.headers.get("x-ratelimit-reset");
    const isAuthError = (response.status === 401 || (response.status === 403 && !isRateLimited));

    if (
      isAuthError &&
      this._auth.apiKeyCommand &&
      !this._keyRefreshed
    ) {
      this._cachedKey = null;
      this._keyFetchPromise = null;
      try {
        this._cachedKey = await this._execCommand(this._auth.apiKeyCommand);
        this._keyRefreshed = true;

        const err = new ClientError(
          "auth_refresh",
          "Refreshing API key and retrying",
          true,
        );
        err.status = response.status;
        throw err;
      } catch (refreshErr) {
        if (refreshErr instanceof ClientError && refreshErr.code === "auth_refresh") {
          throw refreshErr;
        }
        if (refreshErr instanceof ConfigError) {
          throw refreshErr;
        }
      }
    }

    return super.handleErrorResponse(response);
  }

  protected override shouldRetry(error: ClientError): boolean {
    if (error.code === "auth_refresh") return true;
    return super.shouldRetry(error);
  }

  override async chat(request: ChatRequest): Promise<ChatResponse> {
    this._keyRefreshed = false;
    return super.chat(request);
  }

  override async *chatStream(request: ChatRequest): AsyncIterable<StreamChunk> {
    this._keyRefreshed = false;
    yield* super.chatStream(request);
  }

  override dispose(): void {
    this._cachedKey = null;
    this._disposed = true;
  }

  private async _resolveKey(): Promise<string | null> {
    if (this._cachedKey) {
      return this._cachedKey;
    }

    // Re-cache static key if cleared by dispose() or key refresh (and no command configured)
    if (this._auth.apiKey && !this._auth.apiKeyCommand) {
      this._cachedKey = this._auth.apiKey;
      return this._cachedKey;
    }

    if (this._auth.apiKeyCommand) {
      // Coalesce concurrent calls
      if (this._keyFetchPromise) {
        return this._keyFetchPromise;
      }
      this._keyFetchPromise = this._execCommand(this._auth.apiKeyCommand)
        .then((key) => {
          this._cachedKey = key;
          return key;
        })
        .finally(() => {
          this._keyFetchPromise = null;
        });
      return this._keyFetchPromise;
    }

    return null;
  }

  /** Execute a shell command and return trimmed stdout. */
  private async _execCommand(command: string): Promise<string> {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);

    try {
      const { stdout } = await execFileAsync("sh", ["-c", command], {
        timeout: 10_000,
      });
      const trimmed = stdout.trim();
      if (!trimmed) {
        throw new ConfigError(
          "key_command_empty",
          "API key command produced empty output (command configured but returned nothing)",
          "",
          false,
        );
      }
      return trimmed;
    } catch (err) {
      if (err instanceof ConfigError) throw err;
      throw new ConfigError(
        "key_command_failed",
        `API key command failed: ${err instanceof Error ? err.message : String(err)}`,
        "",
        false,
        err instanceof Error ? err : undefined,
      );
    }
  }
}
