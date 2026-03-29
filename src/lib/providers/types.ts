// src/lib/providers/types.ts
import type {
  ChatRequest,
  ChatResponse,
  StreamChunk,
  ModelInfo,
} from "../types.js";

/**
 * Core abstraction for all review providers (Copilot, Ollama, etc.).
 * Every provider implements this interface.
 */
export interface ReviewProvider {
  readonly name: string;

  /**
   * Validate provider configuration and connectivity. Called once after construction,
   * before any other method. Idempotent — second call is a no-op.
   * If throws, provider is safe to dispose() immediately.
   * Partial initialization is treated as failure (throws).
   *   - CopilotProvider: validates auth token, exchanges session token
   *   - OllamaProvider: checks base URL reachability (GET /api/tags, 5s timeout)
   */
  initialize(): Promise<void>;

  /**
   * Non-streaming chat completion. Throws ClientError on API failure.
   * Throws AuthError on auth failure (non-retryable).
   */
  chat(request: ChatRequest): Promise<ChatResponse>;

  /**
   * Streaming chat completion. Yields StreamChunk objects.
   * Error contract:
   *   - Connection/auth errors before first yield: throws (does NOT yield error chunk)
   *   - Mid-stream errors: yields { type: "error", text: "..." } chunk, then returns.
   *     Provider MUST NOT yield any further chunks after an error chunk.
   *   - Normal completion: final chunk is { type: "done", usage, model }
   * Callers MAY break iteration early upon receiving an error chunk.
   */
  chatStream(request: ChatRequest): AsyncIterable<StreamChunk>;

  /** List available models on this provider. Throws ClientError on API failure. */
  listModels(): Promise<ModelInfo[]>;

  /** Validate a model ID exists. Throws ModelError if not found. */
  validateModel(id: string): Promise<ModelInfo>;

  /**
   * Auto-select best model (optional — not all providers support this).
   * When absent, callers must require explicit model selection.
   */
  autoSelect?(): Promise<string>;

  /**
   * Release resources (cached tokens, connections).
   * Must not throw — swallow errors. Must complete synchronously.
   * SECURITY: CopilotProvider MUST zero out cached session token.
   * CLI: called in process exit handler. MCP: called on transport close.
   */
  dispose(): void;

  /**
   * Health check — verify provider is reachable. Returns latency in ms.
   * Called only by `status` command. May be called before initialize().
   * If credentials needed but not initialized, returns { ok: false, error: "not_initialized" }.
   * Timeout: 5 seconds. Must not throw.
   */
  healthCheck(): Promise<{ ok: boolean; latencyMs: number | null; error?: string }>;
}
