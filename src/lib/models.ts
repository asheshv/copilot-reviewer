// src/lib/models.ts

import type { AuthProvider, ModelInfo } from "./types.js";
import { ModelError } from "./types.js";

const BASE_URL = "https://api.githubcopilot.com";
const CACHE_TTL_MS = 300_000; // 5 minutes

/**
 * Raw model data from the API.
 */
interface RawModelData {
  id: string;
  name: string;
  version: string;
  model_picker_enabled: boolean;
  capabilities: {
    type: string;
    limits: {
      max_prompt_tokens: number;
      max_output_tokens: number;
    };
  };
  endpoints: string[];
  streaming: boolean;
  tool_calls: boolean;
  tokenizer: string;
  policy?: {
    state: string;
  };
}

/**
 * Manager for GitHub Copilot models.
 * Handles model listing, validation, auto-selection, and policy management.
 */
export class ModelManager {
  private _cache: ModelInfo[] | null = null;
  private _cacheExpiry: number = 0;

  constructor(private auth: AuthProvider) {}

  /**
   * List all available chat models.
   * Results are filtered to chat-capable, user-selectable models only.
   * Deduplicates by name, keeping the highest version.
   * Auto-enables disabled models via policy API.
   * Results are cached for 5 minutes.
   *
   * @returns Array of ModelInfo
   */
  async listModels(): Promise<ModelInfo[]> {
    const now = Date.now();

    // Return cached results if still valid
    if (this._cache && this._cacheExpiry > now) {
      return this._cache;
    }

    // Fetch models from API
    const headers = await this._buildHeaders();
    const response = await fetch(`${BASE_URL}/models`, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      throw new ModelError(
        "model_list_failed",
        `Failed to fetch models: ${response.status} ${response.statusText}`,
        false
      );
    }

    const json = (await response.json()) as any;
    const rawModels = json.data as RawModelData[];

    // Filter to chat-capable, user-selectable models
    let filtered = rawModels.filter(
      (m) => m.capabilities.type === "chat" && m.model_picker_enabled
    );

    // Auto-enable disabled models
    await this._enableDisabledModels(filtered);

    // Deduplicate by name, keeping highest version
    const deduplicated = this._deduplicateByVersion(filtered);

    // Transform to ModelInfo
    const models = deduplicated.map((m) => this._transformToModelInfo(m));

    // Cache results
    this._cache = models;
    this._cacheExpiry = now + CACHE_TTL_MS;

    return models;
  }

  /**
   * Auto-select a model using the Copilot API.
   *
   * @returns Selected model ID
   * @throws ModelError with code "auto_select_failed" on API error
   */
  async autoSelect(): Promise<string> {
    const headers = await this._buildHeaders();
    const body = {
      auto_mode: {
        model_hints: ["auto"],
      },
    };

    let response: Response;
    try {
      response = await fetch(`${BASE_URL}/models/session`, {
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
   * Validate a model ID and return its metadata.
   *
   * @param id - Model ID to validate
   * @returns ModelInfo for the model
   * @throws ModelError with code "model_not_found" if model not found
   */
  async validateModel(id: string): Promise<ModelInfo> {
    const models = await this.listModels();
    const model = models.find((m) => m.id === id);

    if (!model) {
      const available = models.map((m) => m.id);
      const error = new ModelError(
        "model_not_found",
        `Model '${id}' not found. Available: ${available.join(", ")}`,
        false
      );
      error.available = available;
      throw error;
    }

    return model;
  }

  /**
   * Auto-enable models with disabled policy state.
   */
  private async _enableDisabledModels(models: RawModelData[]): Promise<void> {
    const disabledModels = models.filter(
      (m) => m.policy && m.policy.state !== "enabled"
    );

    // Enable all disabled models in parallel
    await Promise.all(
      disabledModels.map((m) => this._enablePolicy(m.id))
    );
  }

  /**
   * Enable a model's policy state.
   */
  private async _enablePolicy(id: string): Promise<void> {
    const headers = await this._buildHeaders();
    const body = { state: "enabled" };

    const response = await fetch(`${BASE_URL}/models/${id}/policy`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      // Don't throw - just log and continue
      // Policy enable is best-effort
      console.error(
        `Failed to enable policy for model ${id}: ${response.status} ${response.statusText}`
      );
    }
  }

  /**
   * Deduplicate models by name, keeping the highest version.
   */
  private _deduplicateByVersion(models: RawModelData[]): RawModelData[] {
    const grouped = new Map<string, RawModelData[]>();

    // Group by name
    for (const model of models) {
      const existing = grouped.get(model.name) || [];
      existing.push(model);
      grouped.set(model.name, existing);
    }

    // Keep highest version for each name
    const result: RawModelData[] = [];
    for (const [, group] of grouped) {
      // Sort by version descending (lexicographically)
      group.sort((a, b) => b.version.localeCompare(a.version));
      result.push(group[0]);
    }

    return result;
  }

  /**
   * Transform raw model data to ModelInfo.
   */
  private _transformToModelInfo(raw: RawModelData): ModelInfo {
    return {
      id: raw.id,
      name: raw.name,
      endpoints: raw.endpoints,
      streaming: raw.streaming,
      toolCalls: raw.tool_calls,
      maxPromptTokens: raw.capabilities.limits.max_prompt_tokens,
      maxOutputTokens: raw.capabilities.limits.max_output_tokens,
      tokenizer: raw.tokenizer,
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
}
