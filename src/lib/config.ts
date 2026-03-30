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

/** Returns true if dir contains config.json or config.md */
async function dirHasConfig(dir: string): Promise<boolean> {
  const jsonPath = join(dir, "config.json");
  const mdPath = join(dir, "config.md");
  try { await access(jsonPath); return true; } catch {}
  try { await access(mdPath); return true; } catch {}
  return false;
}

/**
 * Resolve global config directory: prefer ~/.code-reviewer, fallback to ~/.copilot-review.
 * Emits a one-time warning if both exist.
 */
async function resolveGlobalConfigDir(): Promise<string> {
  const home = homedir();
  const newDir = join(home, ".code-reviewer");
  const oldDir = join(home, ".copilot-review");

  const newExists = await dirHasConfig(newDir);
  const oldExists = await dirHasConfig(oldDir);

  if (newExists && oldExists) {
    process.stderr.write(
      "Warning: both ~/.code-reviewer/ and ~/.copilot-review/ exist. Using ~/.code-reviewer/. Run 'copilot-review status' for details.\n"
    );
    return newDir;
  }

  if (newExists) {
    return newDir;
  }

  // fallback to old path (may also not exist — loadConfigLayer handles that gracefully)
  return oldDir;
}

/**
 * Resolve project config directory: prefer <git-root>/.code-reviewer, fallback to .copilot-review.
 * Emits a one-time warning if both exist.
 */
async function resolveProjectConfigDir(gitRoot: string): Promise<string> {
  const newDir = join(gitRoot, ".code-reviewer");
  const oldDir = join(gitRoot, ".copilot-review");

  const newExists = await dirHasConfig(newDir);
  const oldExists = await dirHasConfig(oldDir);

  if (newExists && oldExists) {
    process.stderr.write(
      `Warning: both ${gitRoot}/.code-reviewer/ and ${gitRoot}/.copilot-review/ exist. Using ${gitRoot}/.code-reviewer/. Run 'copilot-review status' for details.\n`
    );
    return newDir;
  }

  if (newExists) {
    return newDir;
  }

  return oldDir;
}

/**
 * Load and merge configuration from all 4 layers.
 *
 * Layer precedence (lowest to highest):
 * 1. Built-in defaults
 * 2. Environment variables (CODEREVIEWER_*)
 * 3. Global config (~/.code-reviewer/ or ~/.copilot-review/)
 * 4. Project config (<git-root>/.code-reviewer/ or .copilot-review/ or --config path)
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
  };

  let currentMode: "extend" | "replace" = "extend";

  // Layer 2: Environment variables
  const envProvider = process.env["CODEREVIEWER_PROVIDER"];
  if (envProvider !== undefined) {
    config.provider = envProvider;
  }

  const envOllamaUrl = process.env["CODEREVIEWER_OLLAMA_URL"];
  if (envOllamaUrl !== undefined) {
    validateUrl(envOllamaUrl, "CODEREVIEWER_OLLAMA_URL");
    config.providerOptions = {
      ...config.providerOptions,
      ollama: { baseUrl: envOllamaUrl },
    };
  }

  const envChunking = process.env["CODEREVIEWER_CHUNKING"];
  if (envChunking !== undefined) {
    if (envChunking !== "auto" && envChunking !== "always" && envChunking !== "never") {
      throw new ConfigError(
        "invalid_chunking",
        `Invalid CODEREVIEWER_CHUNKING value: "${envChunking}". Must be "auto", "always", or "never".`,
        "CODEREVIEWER_CHUNKING",
        false
      );
    }
    config.chunking = envChunking;
  }

  // Layer 3: Global config
  const globalDir = await resolveGlobalConfigDir();
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
      projectDir = await resolveProjectConfigDir(gitRoot);
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
      result.providerOptions = jsonConfig.providerOptions as ResolvedConfig["providerOptions"];
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
    // ENOENT is ok (layer doesn't exist), but other errors should be thrown
    if ((error as any).code !== "ENOENT") {
      throw error;
    }
    // ENOENT is ok, layer just doesn't exist
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
  // (prevents reading arbitrary files via malicious .copilot-review/config.json committed to a repo)
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
