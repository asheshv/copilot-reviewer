// src/lib/providers/index.ts

import { ConfigError, type ResolvedConfig } from "../types.js";
import { createDefaultAuthProvider } from "../auth.js";
import { CopilotProvider } from "./copilot-provider.js";
import { OllamaProvider } from "./ollama-provider.js";
import type { ReviewProvider } from "./types.js";

export type { ReviewProvider } from "./types.js";

type ProviderFactory = (config: ResolvedConfig) => ReviewProvider;

const PROVIDERS: Record<string, ProviderFactory> = {
  copilot: (config) => new CopilotProvider(createDefaultAuthProvider(), config.timeout),
  ollama: (config) => {
    const url = (config.providerOptions as any)?.ollama?.baseUrl ?? "http://localhost:11434";
    return new OllamaProvider(url, config.timeout);
  },
};

/**
 * Construct a provider without calling initialize().
 * Used by the status command to run healthCheck() before full initialization.
 */
export function constructProvider(config: ResolvedConfig): ReviewProvider {
  const factory = PROVIDERS[config.provider];
  if (!factory) {
    const available = Object.keys(PROVIDERS).join(", ");
    throw new ConfigError(
      "unknown_provider",
      `Unknown provider '${config.provider}'. Available: ${available}. Check your config file or --provider flag.`,
      "",
      false
    );
  }
  return factory(config);
}

export async function createProvider(config: ResolvedConfig): Promise<ReviewProvider> {
  const factory = PROVIDERS[config.provider];
  if (!factory) {
    const available = Object.keys(PROVIDERS).join(", ");
    throw new ConfigError(
      "unknown_provider",
      `Unknown provider '${config.provider}'. Available: ${available}. Check your config file or --provider flag.`,
      "",
      false
    );
  }
  try {
    const provider = factory(config);
    await provider.initialize();
    return provider;
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(
      "provider_init_failed",
      `Failed to initialize provider '${config.provider}': ${error instanceof Error ? error.message : String(error)}`,
      "",
      false,
      error instanceof Error ? error : undefined
    );
  }
}

export function availableProviders(): string[] {
  return Object.keys(PROVIDERS);
}
