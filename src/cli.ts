#!/usr/bin/env node
// src/cli.ts

import { Command, Option } from "commander";
import {
  AuthError,
  DiffError,
  ClientError,
  ModelError,
  ConfigError,
  ReviewError,
  EXIT_CODES,
  type DiffOptions,
  type OutputFormat,
  type ReviewOptions,
  type CLIOverrides,
} from "./lib/index.js";
import { loadConfig } from "./lib/config.js";
import { resolveToken } from "./lib/auth.js";
import { createProvider } from "./lib/providers/index.js";
import type { StatusOutput } from "./lib/types.js";
import { review, reviewStream } from "./lib/review.js";
import { detectHighSeverity, formatNdjsonChunk } from "./lib/formatter.js";

const VERSION = "1.0.0";

// ============================================================================
// Helpers
// ============================================================================

function isVerbose(explicitFlag: boolean): boolean {
  return explicitFlag || process.env.DEBUG === "llm-review";
}

function progress(msg: string): void {
  process.stderr.write(msg);
}

function debug(verbose: boolean, msg: string): void {
  if (verbose) {
    process.stderr.write(`[debug] ${msg}\n`);
  }
}

/**
 * Map an error to the appropriate CLI exit code.
 */
export function mapErrorToExitCode(err: unknown): number {
  if (err instanceof AuthError) return EXIT_CODES.AUTH_ERROR;
  if (err instanceof DiffError) return EXIT_CODES.DIFF_ERROR;
  if (err instanceof ConfigError) return EXIT_CODES.CONFIG_ERROR;
  if (err instanceof ModelError) return EXIT_CODES.MODEL_ERROR;
  if (err instanceof ReviewError) return EXIT_CODES.DIFF_ERROR; // diff_too_large is a review-level diff error
  if (err instanceof ClientError) return EXIT_CODES.API_ERROR;
  return EXIT_CODES.API_ERROR; // Unknown errors get exit code 4
}

/**
 * Parse mode + modeArg into DiffOptions.
 */
function buildDiffOptions(mode: string, modeArg: string | undefined, defaultBase: string): DiffOptions {
  switch (mode) {
    case "unstaged":
      return { mode: "unstaged" };
    case "staged":
      return { mode: "staged" };
    case "local":
      return { mode: "local" };
    case "branch":
      return { mode: "branch", base: modeArg ?? defaultBase };
    case "pr": {
      const pr = modeArg ? parseInt(modeArg, 10) : NaN;
      if (isNaN(pr)) {
        throw new DiffError("pr_not_found", "PR mode requires a numeric PR number.", false);
      }
      return { mode: "pr", pr };
    }
    case "commits": {
      const count = modeArg ? parseInt(modeArg, 10) : NaN;
      if (isNaN(count) || count <= 0) {
        throw new DiffError("invalid_ref", "Commits mode requires a positive number.", false);
      }
      return { mode: "commits", count };
    }
    case "range":
      if (!modeArg) {
        throw new DiffError("invalid_ref", "Range mode requires a ref range (e.g., main..HEAD).", false);
      }
      return { mode: "range", range: modeArg };
    default:
      return { mode: "local" };
  }
}

// ============================================================================
// CLI Options interface (what commander gives us)
// ============================================================================

interface CLIOpts {
  model?: string;
  format?: string;
  stream?: boolean;
  prompt?: string;
  config?: string;
  verbose?: boolean;
  mcp?: boolean;
  provider?: string;
  chunking?: string;
  ollamaUrl?: string;
  timeout?: string;
}

// ============================================================================
// Handler: review
// ============================================================================

export async function handleReview(
  mode: string,
  modeArg: string | undefined,
  opts: CLIOpts,
): Promise<number> {
  const verbose = isVerbose(opts.verbose ?? false);

  try {
    // TTY detection: default to json when not a TTY and no explicit --format
    let formatOverride = opts.format as OutputFormat | undefined;
    if (!formatOverride && !process.stdout.isTTY) {
      formatOverride = "json";
    }

    // Build CLI overrides
    const cliOverrides: CLIOverrides = {};
    if (opts.model) cliOverrides.model = opts.model;
    if (formatOverride) cliOverrides.format = formatOverride;
    if (opts.stream !== undefined) cliOverrides.stream = opts.stream;
    if (opts.prompt) cliOverrides.prompt = opts.prompt;
    if (opts.config) cliOverrides.config = opts.config;
    if (opts.provider) cliOverrides.provider = opts.provider;
    if (opts.chunking) {
      const validChunking = ["auto", "always", "never"] as const;
      if (!validChunking.includes(opts.chunking as "auto" | "always" | "never")) {
        throw new ConfigError(
          "invalid_config",
          `Invalid --chunking value: '${opts.chunking}'. Must be one of: ${validChunking.join(", ")}.`,
          "--chunking",
          false
        );
      }
      cliOverrides.chunking = opts.chunking as "auto" | "always" | "never";
    }
    if (opts.ollamaUrl) cliOverrides.ollamaUrl = opts.ollamaUrl;
    if (opts.timeout) cliOverrides.timeout = parseInt(opts.timeout, 10);

    progress("Loading configuration... ");
    debug(verbose, `CLI overrides: ${JSON.stringify(cliOverrides)}`);
    const config = await loadConfig(cliOverrides);
    progress("done\n");
    debug(verbose, `Resolved config: model=${config.model}, format=${config.format}, stream=${config.stream}, timeout=${config.timeout}s`);

    // Build diff options
    const diffOpts = buildDiffOptions(mode, modeArg, config.defaultBase);
    debug(verbose, `Diff mode: ${diffOpts.mode}, arg: ${modeArg ?? "none"}`);

    // Create provider
    const provider = await createProvider(config);
    process.on("exit", () => provider.dispose());

    try {
      const reviewOpts: ReviewOptions = {
        diff: diffOpts,
        config,
      };

      // Determine streaming behavior
      const shouldStream = config.stream;

      if (shouldStream) {
        progress("Requesting review (streaming)... \n");
        const result = await reviewStream(reviewOpts, provider);

        if (result.warnings.length > 0) {
          for (const w of result.warnings) {
            process.stderr.write(`Warning: ${w}\n`);
          }
        }

        // Stream to stdout
        let fullContent = "";
        if (config.format === "json") {
          // NDJSON mode
          for await (const chunk of result.stream) {
            const ndjson = formatNdjsonChunk({ type: "content", text: chunk });
            process.stdout.write(ndjson);
            fullContent += chunk;
          }
          // Final done chunk
          process.stdout.write(formatNdjsonChunk({ type: "done" }));
        } else {
          // text/markdown: stream raw text
          for await (const chunk of result.stream) {
            process.stdout.write(chunk);
            fullContent += chunk;
          }
          process.stdout.write("\n");
        }

        // result.usage is populated after the stream is fully consumed (above)
        debug(verbose, `Streaming complete, model=${result.model}`);
        if (result.usage) {
          process.stderr.write(`\nToken usage: ${result.usage.totalTokens.toLocaleString("en-US")} tokens | Model: ${result.model}\n`);
        }
        return detectHighSeverity(fullContent) ? EXIT_CODES.HIGH_SEVERITY : EXIT_CODES.SUCCESS;
      } else {
        progress("Requesting review... ");
        const result = await review(reviewOpts, provider);
        progress("done\n");

        if (result.warnings.length > 0) {
          for (const w of result.warnings) {
            process.stderr.write(`Warning: ${w}\n`);
          }
        }

        debug(verbose, `Review complete, model=${result.model}, tokens=${result.usage?.totalTokens ?? "unknown"}`);
        if (result.usage) {
          process.stderr.write(`Token usage: ${result.usage.totalTokens.toLocaleString("en-US")} tokens | Model: ${result.model}\n`);
        }
        process.stdout.write(result.content + "\n");

        return detectHighSeverity(result.content) ? EXIT_CODES.HIGH_SEVERITY : EXIT_CODES.SUCCESS;
      }
    } catch (err) {
      provider.dispose();
      throw err;
    }
  } catch (err) {
    const code = mapErrorToExitCode(err);
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    debug(verbose, `Exit code: ${code}`);
    return code;
  }
}

// ============================================================================
// Handler: models
// ============================================================================

export async function handleModels(opts: Pick<CLIOpts, "provider" | "ollamaUrl"> = {}): Promise<number> {
  try {
    progress("Fetching models... ");
    const cliOverrides: CLIOverrides = {};
    if (opts.provider) cliOverrides.provider = opts.provider;
    if (opts.ollamaUrl) cliOverrides.ollamaUrl = opts.ollamaUrl;
    const config = await loadConfig(cliOverrides);
    const provider = await createProvider(config);
    process.on("exit", () => provider.dispose());

    try {
      const list = await provider.listModels();
      progress("done\n");

      // Print table header
      const header = `${"ID".padEnd(30)} ${"Name".padEnd(25)} ${"Streaming".padEnd(10)} ${"Tools".padEnd(6)} ${"Max Tokens".padEnd(12)}`;
      process.stdout.write(header + "\n");
      process.stdout.write("-".repeat(header.length) + "\n");

      for (const m of list) {
        const row = `${m.id.padEnd(30)} ${m.name.padEnd(25)} ${String(m.streaming).padEnd(10)} ${String(m.toolCalls).padEnd(6)} ${String(m.maxPromptTokens).padEnd(12)}`;
        process.stdout.write(row + "\n");
      }

      return EXIT_CODES.SUCCESS;
    } catch (err) {
      provider.dispose();
      throw err;
    }
  } catch (err) {
    const code = mapErrorToExitCode(err);
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    return code;
  }
}

// ============================================================================
// Handler: chat
// ============================================================================

export async function handleChat(message: string): Promise<number> {
  try {
    progress("Sending message... ");
    const config = await loadConfig();
    const provider = await createProvider(config);
    process.on("exit", () => provider.dispose());

    try {
      // Auto-select model
      let modelId: string;
      if (provider.autoSelect) {
        modelId = await provider.autoSelect();
      } else {
        const models = await provider.listModels();
        if (models.length === 0) {
          throw new Error("No models available from provider");
        }
        modelId = models[0].id;
      }

      const response = await provider.chat({
        model: modelId,
        systemPrompt: "",
        messages: [{ role: "user", content: message }],
        stream: false,
      });
      progress("done\n");

      process.stdout.write(response.content + "\n");
      return EXIT_CODES.SUCCESS;
    } catch (err) {
      provider.dispose();
      throw err;
    }
  } catch (err) {
    const code = mapErrorToExitCode(err);
    const message_ = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message_}\n`);
    return code;
  }
}

// ============================================================================
// Handler: status
// ============================================================================

interface StatusOpts {
  json?: boolean;
  provider?: string;
  ollamaUrl?: string;
}

/**
 * Determine auth method by attempting token resolution and inspecting env / config files.
 * Returns the StatusOutput auth section.
 */
async function resolveAuthStatus(): Promise<StatusOutput["auth"]> {
  try {
    // Attempt token resolution — if it throws, auth is invalid
    const token = await resolveToken();

    // Determine method by source priority (mirrors resolveToken logic)
    let method: string;
    if (process.env.GITHUB_TOKEN?.trim()) {
      method = "env_token";
    } else {
      // Check copilot config files existence
      const os = await import("os");
      const fs = await import("fs/promises");
      const home = os.homedir();
      const configPaths = [
        `${home}/.config/github-copilot/hosts.json`,
        `${home}/.config/github-copilot/apps.json`,
      ];
      let foundConfig = false;
      for (const p of configPaths) {
        try {
          const content = await fs.readFile(p, "utf-8");
          const cfg = JSON.parse(content);
          for (const [host, data] of Object.entries(cfg)) {
            if (
              (host === "github.com" || host.startsWith("github.com:")) &&
              typeof data === "object" &&
              data !== null &&
              typeof (data as Record<string, unknown>).oauth_token === "string"
            ) {
              foundConfig = true;
              break;
            }
          }
          if (foundConfig) break;
        } catch {
          // file missing or unreadable
        }
      }
      method = foundConfig ? "copilot_config" : "gh_cli";
    }

    return { method, valid: true };
  } catch (err) {
    return {
      method: "none",
      valid: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Compute config file existence info for the status display.
 * Returns paths used by config.ts and whether each was found.
 */
async function resolveConfigStatus(): Promise<StatusOutput["config"]> {
  const os = await import("os");
  const fs = await import("fs/promises");
  const path = await import("path");

  const home = os.homedir();
  const globalPath = path.join(home, ".llm-reviewer", "config.json");

  async function fileExists(p: string): Promise<boolean> {
    try { await fs.access(p); return true; } catch { return false; }
  }

  const globalEntry: StatusOutput["config"]["global"] = {
    path: globalPath,
    found: await fileExists(globalPath),
  };

  // Project config: try to detect git root
  let projectEntry: StatusOutput["config"]["project"];
  try {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"]);
    const gitRoot = stdout.trim();
    const projectPath = path.join(gitRoot, ".llm-reviewer", "config.json");
    projectEntry = { path: projectPath, found: await fileExists(projectPath) };
  } catch {
    projectEntry = { path: "(not in a git repo)", found: false };
  }

  return { global: globalEntry, project: projectEntry };
}

export async function handleStatus(opts: StatusOpts): Promise<number> {
  try {
    const cliOverrides: CLIOverrides = {};
    if (opts.provider) cliOverrides.provider = opts.provider;
    if (opts.ollamaUrl) cliOverrides.ollamaUrl = opts.ollamaUrl;

    const config = await loadConfig(cliOverrides);

    // Auth check (independent of provider)
    const auth = await resolveAuthStatus();

    // Config paths
    const configInfo = await resolveConfigStatus();

    // Provider health check
    let apiResult: StatusOutput["api"] = {
      reachable: false,
      latencyMs: null,
      error: "provider not initialized",
    };
    let provider: Awaited<ReturnType<typeof createProvider>> | null = null;
    let healthy = auth.valid;

    try {
      provider = await createProvider(config);
    } catch (err) {
      // Provider creation failed — skip health check
      apiResult = {
        reachable: false,
        latencyMs: null,
        error: err instanceof Error ? err.message : String(err),
      };
      healthy = false;
    }

    if (provider) {
      try {
        const health = await provider.healthCheck();
        apiResult = {
          reachable: health.ok,
          latencyMs: health.latencyMs,
          error: health.error,
        };
        if (!health.ok) healthy = false;
      } catch (err) {
        apiResult = {
          reachable: false,
          latencyMs: null,
          error: err instanceof Error ? err.message : String(err),
        };
        healthy = false;
      }
    }

    // Model resolution
    let resolvedModel: string | null = null;
    if (provider && apiResult.reachable && config.model === "auto" && provider.autoSelect) {
      try {
        resolvedModel = await provider.autoSelect();
      } catch {
        // auto-select failed — leave null
      }
    }

    // List models (only when reachable)
    let models: string[] | null = null;
    let modelsError: string | null = null;
    if (provider && apiResult.reachable) {
      try {
        const list = await provider.listModels();
        models = list.map((m) => m.id);
      } catch (err) {
        modelsError = err instanceof Error ? err.message : String(err);
        healthy = false;
      }
    }

    const output: StatusOutput = {
      provider: config.provider,
      model: {
        configured: config.model,
        resolved: resolvedModel,
      },
      chunking: config.chunking,
      stream: config.stream,
      format: config.format,
      config: configInfo,
      auth,
      api: apiResult,
      models,
      modelsError,
      healthy,
    };

    if (opts.json) {
      process.stdout.write(JSON.stringify(output, null, 2) + "\n");
    } else {
      // Text mode — human-readable
      const tick = "✓";
      const cross = "✗";

      const modelDisplay =
        output.model.configured === "auto" && output.model.resolved
          ? `auto → ${output.model.resolved} (auto-selected)`
          : output.model.configured;

      const authDisplay = output.auth.valid
        ? `${output.auth.method} ${tick}`
        : `${cross} — ${output.auth.error ?? "unknown error"}`;

      const apiDisplay = output.api.reachable
        ? `${tick} (${output.api.latencyMs}ms)`
        : `${cross} — ${output.api.error ?? "unreachable"}`;

      const globalConfigDisplay = output.config.global.found
        ? `${output.config.global.path} (found)`
        : `${output.config.global.path} (not found)`;

      const projectConfigDisplay = output.config.project.found
        ? `${output.config.project.path} (found)`
        : `${output.config.project.path} (not found)`;

      const lines = [
        `  Provider:         ${output.provider}`,
        `  Model:            ${modelDisplay}`,
        `  Chunking:         ${output.chunking}`,
        `  Stream:           ${output.stream}`,
        `  Format:           ${output.format}`,
        `  Config (global):  ${globalConfigDisplay}`,
        `  Config (project): ${projectConfigDisplay}`,
        `  Auth:             ${authDisplay}`,
        `  API reachable:    ${apiDisplay}`,
      ];

      if (output.models) {
        lines.push(`  Models:           ${output.models.join(", ")}`);
      } else if (output.modelsError) {
        lines.push(`  Models:           ${cross} — ${output.modelsError}`);
      }

      process.stdout.write(lines.join("\n") + "\n");
    }

    if (provider) {
      provider.dispose();
    }

    return healthy ? EXIT_CODES.SUCCESS : 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    return EXIT_CODES.API_ERROR;
  }
}

// ============================================================================
// Build commander program (exported for testing)
// ============================================================================

export function buildProgram(): Command {
  const program = new Command()
    .name("llm-review")
    .version(VERSION)
    .description("Review code changes using LLMs")
    .enablePositionalOptions()
    .argument("[mode]", "Diff mode: unstaged|staged|local|branch|pr|commits|range", "local")
    .argument("[modeArg]", "Mode argument (base branch, PR number, etc.)")
    .option("--model <id>", "Model to use")
    .option("--format <fmt>", "Output format: text|markdown|json")
    .option("--stream", "Force streaming output")
    .option("--no-stream", "Force buffered output")
    .option("--prompt <text>", "Override review prompt")
    .option("--config <path>", "Override config file path")
    .option("--verbose", "Enable debug logging to stderr")
    .option("--provider <name>", "Review provider: copilot, ollama")
    .option("--chunking <mode>", "Chunking mode: auto, always, never")
    .option("--ollama-url <url>", "Ollama base URL")
    .option("--timeout <seconds>", "Request timeout in seconds (default: 30 for copilot, 120 for ollama)")
    .addOption(new Option("--mcp", "Start as MCP server").hideHelp())
    .action(async (mode: string, modeArg: string | undefined, opts: CLIOpts) => {
      const code = await handleReview(mode, modeArg, opts);
      process.exit(code);
    });

  // Subcommands
  program
    .command("models")
    .description("List available models")
    .option("--provider <name>", "Review provider: copilot, ollama")
    .option("--ollama-url <url>", "Ollama base URL")
    .action(async (opts: Pick<CLIOpts, "provider" | "ollamaUrl">) => {
      const code = await handleModels(opts);
      process.exit(code);
    });

  program
    .command("chat <message>")
    .description("Chat with LLM")
    .action(async (message: string) => {
      const code = await handleChat(message);
      process.exit(code);
    });

  program
    .command("status")
    .description("Show provider connectivity and configuration status")
    .option("--json", "Output status as JSON")
    .option("--provider <name>", "Review provider: copilot, ollama")
    .option("--ollama-url <url>", "Ollama base URL")
    .action(async (opts: StatusOpts) => {
      const code = await handleStatus(opts);
      process.exit(code);
    });

  return program;
}

// ============================================================================
// Main entry point — only runs when executed directly, not when imported
// ============================================================================

async function main(): Promise<void> {
  const program = buildProgram();

  // Check for --mcp before full parse (so --help still works)
  if (process.argv.includes("--mcp")) {
    const { startServer } = await import("./mcp-server.js");
    await startServer();
    return; // never reached — server runs until killed
  }

  await program.parseAsync(process.argv);
}

// Only run main when this file is the entry point (not when imported for testing)
// Run main() only when executed as a CLI entry point, not when imported by tests.
// Check: argv[1] resolves to this file (dist/cli.js) or the bin symlink (llm-review).
const scriptPath = process.argv[1] ?? "";
const isEntryPoint =
  scriptPath.endsWith("/cli.js") ||
  scriptPath.endsWith("/cli.ts") ||
  scriptPath.endsWith("/llm-review") ||
  scriptPath.endsWith("/.bin/llm-review");

if (isEntryPoint) {
  main().catch((err) => {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
