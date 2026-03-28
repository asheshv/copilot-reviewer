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
import { createDefaultAuthProvider } from "./lib/auth.js";
import { CopilotClient } from "./lib/client.js";
import { ModelManager } from "./lib/models.js";
import { review, reviewStream } from "./lib/review.js";
import { detectHighSeverity, formatNdjsonChunk } from "./lib/formatter.js";

const VERSION = "0.1.0";

// ============================================================================
// Helpers
// ============================================================================

function isVerbose(explicitFlag: boolean): boolean {
  return explicitFlag || process.env.DEBUG === "copilot-review";
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

    progress("Loading configuration... ");
    debug(verbose, `CLI overrides: ${JSON.stringify(cliOverrides)}`);
    const config = await loadConfig(cliOverrides);
    progress("done\n");
    debug(verbose, `Resolved config: model=${config.model}, format=${config.format}, stream=${config.stream}`);

    // Build diff options
    const diffOpts = buildDiffOptions(mode, modeArg, config.defaultBase);
    debug(verbose, `Diff mode: ${diffOpts.mode}, arg: ${modeArg ?? "none"}`);

    // Create infrastructure
    const auth = createDefaultAuthProvider();
    const client = new CopilotClient(auth);
    const models = new ModelManager(auth);

    const reviewOpts: ReviewOptions = {
      diff: diffOpts,
      config,
    };

    // Determine streaming behavior
    const shouldStream = config.stream;

    if (shouldStream) {
      progress("Requesting review (streaming)... \n");
      const result = await reviewStream(reviewOpts, client, models);

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

      debug(verbose, `Streaming complete, model=${result.model}`);
      if (result.usage) {
        process.stderr.write(`\nToken usage: ${result.usage.totalTokens.toLocaleString("en-US")} tokens | Model: ${result.model}\n`);
      }
      return detectHighSeverity(fullContent) ? EXIT_CODES.HIGH_SEVERITY : EXIT_CODES.SUCCESS;
    } else {
      progress("Requesting review... ");
      const result = await review(reviewOpts, client, models);
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

export async function handleModels(): Promise<number> {
  try {
    progress("Fetching models... ");
    const auth = createDefaultAuthProvider();
    const models = new ModelManager(auth);
    const list = await models.listModels();
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
    const auth = createDefaultAuthProvider();
    const client = new CopilotClient(auth);
    const models = new ModelManager(auth);

    // Auto-select model
    const modelId = await models.autoSelect();
    const modelInfo = await models.validateModel(modelId);

    const useResponsesApi = modelInfo.endpoints.includes("/responses");

    const response = await client.chat(
      {
        model: modelInfo.id,
        systemPrompt: "",
        messages: [{ role: "user", content: message }],
        stream: false,
      },
      useResponsesApi,
    );
    progress("done\n");

    process.stdout.write(response.content + "\n");
    return EXIT_CODES.SUCCESS;
  } catch (err) {
    const code = mapErrorToExitCode(err);
    const message_ = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message_}\n`);
    return code;
  }
}

// ============================================================================
// Build commander program (exported for testing)
// ============================================================================

export function buildProgram(): Command {
  const program = new Command()
    .name("copilot-review")
    .version(VERSION)
    .description("Review code changes using GitHub Copilot");

  // Main review command
  program
    .argument("[mode]", "Diff mode: unstaged|staged|local|branch|pr|commits|range", "local")
    .argument("[modeArg]", "Mode argument (base branch, PR number, etc.)")
    .option("--model <id>", "Model to use")
    .option("--format <fmt>", "Output format: text|markdown|json")
    .option("--stream", "Force streaming output")
    .option("--no-stream", "Force buffered output")
    .option("--prompt <text>", "Override review prompt")
    .option("--config <path>", "Override config file path")
    .option("--verbose", "Enable debug logging to stderr")
    .addOption(new Option("--mcp", "Start as MCP server").hideHelp())
    .action(async (mode: string, modeArg: string | undefined, opts: CLIOpts) => {
      const code = await handleReview(mode, modeArg, opts);
      process.exit(code);
    });

  // Subcommands
  program
    .command("models")
    .description("List available models")
    .action(async () => {
      const code = await handleModels();
      process.exit(code);
    });

  program
    .command("chat <message>")
    .description("Chat with Copilot")
    .action(async (message: string) => {
      const code = await handleChat(message);
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
// Check: argv[1] resolves to this file (dist/cli.js) or the bin symlink (copilot-review).
const scriptPath = process.argv[1] ?? "";
const isEntryPoint =
  scriptPath.endsWith("/cli.js") ||
  scriptPath.endsWith("/cli.ts") ||
  scriptPath.endsWith("/copilot-review") ||
  scriptPath.endsWith("/.bin/copilot-review");

if (isEntryPoint) {
  main().catch((err) => {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
