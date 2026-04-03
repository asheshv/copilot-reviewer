// src/lib/config.ts
import { readFile, access } from "fs/promises";
import { homedir } from "os";
import { join, isAbsolute, dirname, resolve } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { loadBuiltInPrompt } from "./prompt.js";
import { ConfigError } from "./types.js";
import type { ConfigFile, ResolvedConfig, CLIOverrides } from "./types.js";
import { availableProviders } from "./providers/index.js";

const execFileAsync = promisify(execFile);

/** Levenshtein distance between two strings */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/** Validate a URL string; throw ConfigError if malformed or non-http/https */
function validateUrl(urlStr: string, context: string): void {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new ConfigError("invalid_url", `Invalid URL in ${context}: '${urlStr}'`, context, false);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError("invalid_url", `URL in ${context} must use http or https scheme: '${urlStr}'`, context, false);
  }
}

/** Return the global config directory path. */
function getGlobalConfigDir(): string {
  return join(homedir(), ".llm-reviewer");
}

/** Return the project config directory path under the given git root. */
function getProjectConfigDir(gitRoot: string): string {
  return join(gitRoot, ".llm-reviewer");
}

/**
 * Load and merge configuration from all 4 layers.
 *
 * Layer precedence (lowest to highest):
 * 1. Built-in defaults
 * 2. Environment variables (LLM_REVIEWER_*)
 * 3. Global config (~/.llm-reviewer/)
 * 4. Project config (<git-root>/.llm-reviewer/ or --config path)
 * 5. CLI overrides
 */
export async function loadConfig(cliOverrides?: CLIOverrides): Promise<ResolvedConfig> {
  // Layer 1: Built-in defaults
  let config: ResolvedConfig = {
    model: "auto",
    format: "markdown",
    stream: true,
    prompt: loadBuiltInPrompt(),
    defaultBase: "main",
    ignorePaths: [],
    provider: "copilot",
    providerOptions: {},
    chunking: "auto",
    timeout: 30, // default 30 seconds, overridden per-provider or via CLI
  };

  let currentMode: "extend" | "replace" = "extend";

  // Layer 2: Environment variables
  const envProvider = process.env["LLM_REVIEWER_PROVIDER"];
  if (envProvider !== undefined) {
    // Not validated here to avoid importing availableProviders() and risking circular
    // dependencies. createProvider() will throw a ConfigError with a clear message if the
    // provider name is unknown (including source attribution).
    config.provider = envProvider;
  }

  const envOllamaUrl = process.env["LLM_REVIEWER_OLLAMA_URL"];
  if (envOllamaUrl !== undefined) {
    validateUrl(envOllamaUrl, "LLM_REVIEWER_OLLAMA_URL");
    config.providerOptions = {
      ...config.providerOptions,
      ollama: { baseUrl: envOllamaUrl },
    };
  }

  // Custom provider env vars — populate providerOptions.custom for bare "custom" usage.
  // Named providers (custom:groq) read from providerOptions.<suffix>, not .custom.
  const envBaseUrl = process.env["LLM_REVIEWER_BASE_URL"];
  const envApiKey = process.env["LLM_REVIEWER_API_KEY"];
  const envApiKeyCommand = process.env["LLM_REVIEWER_API_KEY_COMMAND"];

  if (envBaseUrl !== undefined) {
    validateUrl(envBaseUrl, "LLM_REVIEWER_BASE_URL");
    const existing = (config.providerOptions.custom ?? {}) as Record<string, unknown>;
    config.providerOptions = {
      ...config.providerOptions,
      custom: { ...existing, baseUrl: envBaseUrl },
    };
  }

  // LLM_REVIEWER_API_KEY takes precedence over LLM_REVIEWER_API_KEY_COMMAND.
  // When an env var is set, clear the opposite type to prevent the factory's
  // "command > static" rule from overriding the env var.
  if (envApiKey !== undefined) {
    const existing = (config.providerOptions.custom ?? {}) as Record<string, unknown>;
    config.providerOptions = {
      ...config.providerOptions,
      custom: { ...existing, apiKey: envApiKey, apiKeyCommand: undefined },
    };
  } else if (envApiKeyCommand !== undefined) {
    const existing = (config.providerOptions.custom ?? {}) as Record<string, unknown>;
    config.providerOptions = {
      ...config.providerOptions,
      custom: { ...existing, apiKeyCommand: envApiKeyCommand, apiKey: undefined },
    };
  }

  const envChunking = process.env["LLM_REVIEWER_CHUNKING"];
  if (envChunking !== undefined) {
    if (envChunking !== "auto" && envChunking !== "always" && envChunking !== "never") {
      throw new ConfigError(
        "invalid_chunking",
        `Invalid LLM_REVIEWER_CHUNKING value: "${envChunking}". Must be "auto", "always", or "never".`,
        "LLM_REVIEWER_CHUNKING",
        false
      );
    }
    config.chunking = envChunking;
  }

  // Layer 3: Global config
  const globalDir = getGlobalConfigDir();
  const globalLayer = await loadConfigLayer(globalDir);
  config = mergeConfig(config, globalLayer, currentMode, "global");
  if (globalLayer.mode) {
    currentMode = globalLayer.mode;
  }

  // Layer 4: Project config (or --config override)
  let projectDir: string | null = null;

  if (cliOverrides?.config) {
    // --config flag replaces project layer
    projectDir = cliOverrides.config;
  } else {
    // Auto-detect git root
    const gitRoot = await detectGitRoot();
    if (gitRoot) {
      projectDir = getProjectConfigDir(gitRoot);
    }
  }

  if (projectDir) {
    const projectLayer = await loadConfigLayer(projectDir);
    config = mergeConfig(config, projectLayer, currentMode, "project");
    if (projectLayer.mode) {
      currentMode = projectLayer.mode;
    }
  }

  // Layer 5: CLI overrides
  if (cliOverrides) {
    if (cliOverrides.model !== undefined) {
      config.model = cliOverrides.model;
    }
    if (cliOverrides.format !== undefined) {
      config.format = cliOverrides.format;
    }
    if (cliOverrides.stream !== undefined) {
      config.stream = cliOverrides.stream;
    }
    if (cliOverrides.prompt !== undefined) {
      // CLI --prompt is always implicit replace
      config.prompt = cliOverrides.prompt;
    }
    if (cliOverrides.provider !== undefined) {
      config.provider = cliOverrides.provider;
    }
    if (cliOverrides.chunking !== undefined) {
      config.chunking = cliOverrides.chunking;
    }
    if (cliOverrides.ollamaUrl !== undefined) {
      config.providerOptions = {
        ...config.providerOptions,
        ollama: { baseUrl: cliOverrides.ollamaUrl },
      };
    }
    if (cliOverrides.baseUrl !== undefined) {
      const existing = (config.providerOptions.custom ?? {}) as Record<string, unknown>;
      config.providerOptions = {
        ...config.providerOptions,
        custom: { ...existing, baseUrl: cliOverrides.baseUrl },
      };
    }
    if (cliOverrides.timeout !== undefined) {
      config.timeout = cliOverrides.timeout;
    }
  }

  // Provider-specific timeout defaults (if not overridden by CLI/config)
  if (config.provider === "ollama" && config.timeout === 30) {
    config.timeout = 120; // 120 seconds default for local Ollama models
  }

  return config;
}

/**
 * Detect git repository root using `git rev-parse --show-toplevel`.
 * Returns null if not in a git repository.
 */
async function detectGitRoot(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"]);
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Load configuration from a single layer (directory).
 * Returns partial config with prompt and mode information.
 */
async function loadConfigLayer(
  dir: string
): Promise<Partial<ConfigFile> & { prompt?: string; mode?: "extend" | "replace" }> {
  const result: Partial<ConfigFile> & { prompt?: string; mode?: "extend" | "replace" } = {};

  // Try config.json first
  const jsonPath = isAbsolute(dir) && dir.endsWith(".json") ? dir : join(dir, "config.json");
  const mdPath = isAbsolute(dir) && dir.endsWith(".md") ? dir : join(dir, "config.md");

  let hasJson = false;
  let jsonConfig: ConfigFile = {};

  try {
    await access(jsonPath);
    hasJson = true;

    const jsonContent = await readFile(jsonPath, "utf-8");
    try {
      jsonConfig = JSON.parse(jsonContent);
    } catch (parseError) {
      throw new ConfigError(
        "malformed_json",
        `Failed to parse config: ${jsonPath}`,
        jsonPath,
        false,
        parseError as Error
      );
    }

    // Merge structured settings
    if (jsonConfig.model !== undefined) result.model = jsonConfig.model;
    if (jsonConfig.format !== undefined) result.format = jsonConfig.format;
    if (jsonConfig.stream !== undefined) result.stream = jsonConfig.stream;
    if (jsonConfig.defaultBase !== undefined) result.defaultBase = jsonConfig.defaultBase;
    if (jsonConfig.ignorePaths !== undefined) result.ignorePaths = jsonConfig.ignorePaths;
    if (jsonConfig.mode !== undefined) result.mode = jsonConfig.mode;
    if (jsonConfig.provider !== undefined) result.provider = jsonConfig.provider;
    if (jsonConfig.chunking !== undefined) result.chunking = jsonConfig.chunking;
    if (jsonConfig.providerOptions !== undefined) {
      // Validate known keys and warn on unknown
      const knownKeys = availableProviders();
      for (const key of Object.keys(jsonConfig.providerOptions)) {
        if (!knownKeys.includes(key)) {
          const suggestion = knownKeys.find((k) => levenshtein(key, k) <= 2);
          const hint = suggestion ? ` Did you mean '${suggestion}'?` : "";
          process.stderr.write(`Warning: unknown providerOptions key '${key}'.${hint}\n`);
        }
      }
      // Validate ollama.baseUrl if present
      if (jsonConfig.providerOptions.ollama?.baseUrl !== undefined) {
        validateUrl(jsonConfig.providerOptions.ollama.baseUrl, jsonPath);
      }
      // Normalize providerOptions: fill in defaults rather than casting, so we never
      // carry optional fields where required fields are expected downstream.
      const normalized: ResolvedConfig["providerOptions"] = {};
      if (jsonConfig.providerOptions.ollama !== undefined) {
        normalized.ollama = {
          baseUrl: jsonConfig.providerOptions.ollama.baseUrl ?? "http://localhost:11434",
        };
      }
      for (const [key, val] of Object.entries(jsonConfig.providerOptions)) {
        if (key !== "ollama") normalized[key] = val as Record<string, unknown>;
      }
      result.providerOptions = normalized;
    }

    // Handle prompt field (inline text or file path)
    if (jsonConfig.prompt !== undefined) {
      result.prompt = await resolvePrompt(jsonConfig.prompt, dirname(jsonPath));
    }
  } catch (error) {
    // Re-throw ConfigError immediately
    if (error instanceof ConfigError) {
      throw error;
    }
    if ((error as any).code === "ENOENT") {
      // Layer doesn't exist — that's fine
    } else if ((error as any).code === "EACCES") {
      throw new ConfigError(
        "config_read_error",
        `Permission denied reading config: ${jsonPath}`,
        jsonPath,
        false,
        error as Error
      );
    } else {
      throw error;
    }
  }

  // If config.json doesn't have a prompt, try config.md
  if (!hasJson || (hasJson && !jsonConfig.prompt)) {
    try {
      await access(mdPath);
      const mdContent = await readFile(mdPath, "utf-8");

      // Only use if not empty/whitespace-only
      if (mdContent.trim().length > 0) {
        result.prompt = mdContent;
      }
    } catch {
      // config.md doesn't exist, that's fine
    }
  }

  return result;
}

/**
 * Resolve a prompt value: inline text or file path.
 */
async function resolvePrompt(value: string, configDir: string): Promise<string> {
  // Security: absolute paths are NEVER allowed in prompt field
  // (prevents reading arbitrary files via malicious .llm-reviewer/config.json committed to a repo)
  if (isAbsolute(value)) {
    throw new ConfigError(
      "prompt_not_found",
      `Absolute paths are not allowed in prompt field for security. Use a relative path within the config directory: ${value}`,
      value,
      false
    );
  }

  // Heuristic: if ends with .md and file exists, treat as relative file path
  if (value.endsWith(".md")) {
    const absolutePath = join(configDir, value);
    const resolved = resolve(absolutePath);

    // Security: prevent path traversal — resolved path must stay within config directory
    const configDirResolved = resolve(configDir) + "/";
    if (!resolved.startsWith(configDirResolved)) {
      throw new ConfigError(
        "prompt_not_found",
        `Prompt path must be within config directory: ${value}`,
        resolved,
        false
      );
    }

    try {
      await access(resolved);
      return await readFile(resolved, "utf-8");
    } catch {
      throw new ConfigError(
        "prompt_not_found",
        `Prompt file not found: ${resolved}`,
        resolved,
        false
      );
    }
  }

  // Otherwise, treat as inline text
  return value;
}

/**
 * Merge a layer into the accumulated config.
 * Handles prompt merge modes and ignorePaths union.
 */
function mergeConfig(
  base: ResolvedConfig,
  layer: Partial<ConfigFile> & { prompt?: string; mode?: "extend" | "replace" },
  currentMode: "extend" | "replace",
  layerType: "global" | "project"
): ResolvedConfig {
  const result = { ...base };

  // Simple overrides
  if (layer.model !== undefined) result.model = layer.model;
  if (layer.format !== undefined) result.format = layer.format;
  if (layer.stream !== undefined) result.stream = layer.stream;
  if (layer.defaultBase !== undefined) result.defaultBase = layer.defaultBase;
  if (layer.provider !== undefined) result.provider = layer.provider;
  if (layer.chunking !== undefined) result.chunking = layer.chunking;

  // providerOptions: shallow merge per provider key
  if (layer.providerOptions !== undefined) {
    result.providerOptions = { ...result.providerOptions, ...layer.providerOptions } as ResolvedConfig["providerOptions"];
  }

  // ignorePaths: union and deduplicate
  if (layer.ignorePaths !== undefined && layer.ignorePaths.length > 0) {
    const combined = [...result.ignorePaths, ...layer.ignorePaths];
    result.ignorePaths = [...new Set(combined)];
  }

  // Prompt: respect mode
  if (layer.prompt !== undefined && layer.prompt.trim().length > 0) {
    const layerMode = layer.mode ?? currentMode;

    if (layerMode === "replace") {
      result.prompt = layer.prompt;
    } else {
      // Extend mode: append with section header
      const sectionHeader =
        layerType === "global"
          ? "## Additional Instructions (Global)"
          : "## Project Instructions";
      result.prompt += `\n\n${sectionHeader}\n${layer.prompt}`;
    }
  }

  return result;
}
