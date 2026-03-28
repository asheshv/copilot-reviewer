// src/lib/config.ts
import { readFile, access } from "fs/promises";
import { homedir } from "os";
import { join, isAbsolute, dirname, resolve } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { loadBuiltInPrompt } from "./prompt.js";
import { ConfigError } from "./types.js";
import type { ConfigFile, ResolvedConfig, CLIOverrides } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Load and merge configuration from all 4 layers.
 *
 * Layer precedence (lowest to highest):
 * 1. Built-in defaults
 * 2. Global config (~/.copilot-review/)
 * 3. Project config (<git-root>/.copilot-review/ or --config path)
 * 4. CLI overrides
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
  };

  let currentMode: "extend" | "replace" = "extend";

  // Layer 2: Global config
  const globalDir = join(homedir(), ".copilot-review");
  const globalLayer = await loadConfigLayer(globalDir);
  config = mergeConfig(config, globalLayer, currentMode, "global");
  if (globalLayer.mode) {
    currentMode = globalLayer.mode;
  }

  // Layer 3: Project config (or --config override)
  let projectDir: string | null = null;

  if (cliOverrides?.config) {
    // --config flag replaces project layer
    projectDir = cliOverrides.config;
  } else {
    // Auto-detect git root
    projectDir = await detectGitRoot();
    if (projectDir) {
      projectDir = join(projectDir, ".copilot-review");
    }
  }

  if (projectDir) {
    const projectLayer = await loadConfigLayer(projectDir);
    config = mergeConfig(config, projectLayer, currentMode, "project");
    if (projectLayer.mode) {
      currentMode = projectLayer.mode;
    }
  }

  // Layer 4: CLI overrides
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
    if (!resolved.startsWith(resolve(configDir))) {
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
