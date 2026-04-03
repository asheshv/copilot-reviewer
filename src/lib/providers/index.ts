// src/lib/providers/index.ts

import { ConfigError, type ResolvedConfig } from "../types.js";
import { createDefaultAuthProvider } from "../auth.js";
import { CopilotProvider } from "./copilot-provider.js";
import { OllamaProvider } from "./ollama-provider.js";
import { CustomProvider } from "./custom-provider.js";
import type { ReviewProvider } from "./types.js";

export type { ReviewProvider } from "./types.js";

type ProviderFactory = (config: ResolvedConfig) => ReviewProvider;

const BUILTIN_PROVIDERS: Record<string, ProviderFactory> = {
  copilot: (config) => new CopilotProvider(createDefaultAuthProvider(), config.timeout),
  ollama: (config) => {
    const url = (config.providerOptions as any)?.ollama?.baseUrl ?? "http://localhost:11434";
    return new OllamaProvider(url, config.timeout);
  },
};

const BUILTIN_NAMES = new Set(Object.keys(BUILTIN_PROVIDERS));

/**
 * Resolve custom provider config from providerOptions.
 *
 * - "custom:groq" -> looks up providerOptions.groq
 * - "custom" with providerOptions.custom -> uses that
 * - "custom" without providerOptions.custom -> first non-builtin entry
 */
function resolveCustomConfig(
  providerName: string,
  config: ResolvedConfig,
): { name: string; baseUrl: string; apiKey?: string; apiKeyCommand?: string } {
  const isNamed = providerName.startsWith("custom:");
  const suffix = isNamed ? providerName.slice("custom:".length) : null;

  if (suffix) {
    const opts = config.providerOptions?.[suffix] as Record<string, unknown> | undefined;
    if (!opts?.baseUrl) {
      throw new ConfigError(
        "missing_provider_config",
        `No configuration found for provider '${providerName}'. Add providerOptions.${suffix}.baseUrl to your config file.`,
        "",
        false,
      );
    }
    // apiKeyCommand wins over apiKey
    const apiKey = opts.apiKeyCommand ? undefined : (opts.apiKey as string | undefined);
    const apiKeyCommand = opts.apiKeyCommand as string | undefined;
    return {
      name: providerName,
      baseUrl: opts.baseUrl as string,
      apiKey,
      apiKeyCommand,
    };
  }

  // Bare "custom" — check providerOptions.custom first
  const customOpts = config.providerOptions?.custom as Record<string, unknown> | undefined;
  if (customOpts?.baseUrl) {
    const apiKey = customOpts.apiKeyCommand ? undefined : (customOpts.apiKey as string | undefined);
    const apiKeyCommand = customOpts.apiKeyCommand as string | undefined;
    return {
      name: "custom",
      baseUrl: customOpts.baseUrl as string,
      apiKey,
      apiKeyCommand,
    };
  }

  // Fall back to first non-builtin providerOptions entry
  for (const [key, val] of Object.entries(config.providerOptions ?? {})) {
    if (!BUILTIN_NAMES.has(key) && key !== "custom" && val && typeof val === "object" && "baseUrl" in val) {
      const entry = val as Record<string, unknown>;
      const apiKey = entry.apiKeyCommand ? undefined : (entry.apiKey as string | undefined);
      const apiKeyCommand = entry.apiKeyCommand as string | undefined;
      return {
        name: "custom",
        baseUrl: entry.baseUrl as string,
        apiKey,
        apiKeyCommand,
      };
    }
  }

  throw new ConfigError(
    "missing_base_url",
    "Custom provider requires a base URL. Set --base-url, LLM_REVIEWER_BASE_URL, or providerOptions.<name>.baseUrl in config.",
    "",
    false,
  );
}

/**
 * Construct a provider without calling initialize().
 * Used by the status command to run healthCheck() before full initialization.
 */
export function constructProvider(config: ResolvedConfig): ReviewProvider {
  const builtinFactory = BUILTIN_PROVIDERS[config.provider];
  if (builtinFactory) {
    return builtinFactory(config);
  }

  if (config.provider === "custom" || config.provider.startsWith("custom:")) {
    const resolved = resolveCustomConfig(config.provider, config);
    return new CustomProvider(
      resolved.name,
      resolved.baseUrl,
      { apiKey: resolved.apiKey, apiKeyCommand: resolved.apiKeyCommand },
      config.timeout,
    );
  }

  const available = [...Object.keys(BUILTIN_PROVIDERS), "custom", "custom:<name>"];
  throw new ConfigError(
    "unknown_provider",
    `Unknown provider '${config.provider}'. Available: ${available.join(", ")}. Check your config file or --provider flag.`,
    "",
    false,
  );
}

export async function createProvider(config: ResolvedConfig): Promise<ReviewProvider> {
  try {
    const provider = constructProvider(config);
    await provider.initialize();
    return provider;
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(
      "provider_init_failed",
      `Failed to initialize provider '${config.provider}': ${error instanceof Error ? error.message : String(error)}`,
      "",
      false,
      error instanceof Error ? error : undefined,
    );
  }
}

export function availableProviders(): string[] {
  return Object.keys(BUILTIN_PROVIDERS);
}
