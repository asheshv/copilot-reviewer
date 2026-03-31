// src/mcp-server.ts

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  LlmReviewError,
  ParameterError,
  type ReviewOptions,
  type DiffOptions,
  type ModelInfo,
} from "./lib/types.js";
import { review } from "./lib/review.js";
import { loadConfig } from "./lib/config.js";
import { createProvider } from "./lib/providers/index.js";
import type { ReviewProvider } from "./lib/providers/types.js";

// ============================================================================
// Constants
// ============================================================================

export const VALID_MODES = [
  "unstaged", "staged", "local", "branch", "pr", "commits", "range",
] as const;

type DiffMode = (typeof VALID_MODES)[number];

// ============================================================================
// Shared instances (long-lived, cached across tool invocations)
// ============================================================================

let _provider: ReviewProvider | null = null;

async function getProvider(): Promise<ReviewProvider> {
  if (!_provider) {
    const config = await loadConfig();
    _provider = await createProvider(config);
  }
  return _provider;
}

// ============================================================================
// Parameter validation
// ============================================================================

export function validateReviewParams(params: Record<string, unknown>): void {
  const mode = params.mode as string;

  if (!VALID_MODES.includes(mode as DiffMode)) {
    throw new ParameterError(
      "invalid_parameter",
      `Invalid mode '${mode}'. Valid: ${VALID_MODES.join(", ")}`,
    );
  }

  if (mode === "pr" && (params.pr === undefined || params.pr === null)) {
    throw new ParameterError(
      "missing_parameter",
      "Mode 'pr' requires 'pr' parameter (PR number)",
    );
  }

  if (mode === "range" && (params.range === undefined || params.range === null)) {
    throw new ParameterError(
      "missing_parameter",
      "Mode 'range' requires 'range' parameter",
    );
  }

  if (mode === "commits" && (params.count === undefined || params.count === null)) {
    throw new ParameterError(
      "missing_parameter",
      "Mode 'commits' requires 'count' parameter",
    );
  }
}

// ============================================================================
// Error mapping
// ============================================================================

function mapErrorToToolResult(err: unknown): CallToolResult {
  if (err instanceof LlmReviewError) {
    const result: Record<string, unknown> = {
      error: err.code,
      message: err.message,
      recoverable: err.recoverable,
    };
    // Include type-specific fields per spec 10
    if ("retryAfter" in err && (err as any).retryAfter != null) {
      result.retryAfter = (err as any).retryAfter;
    }
    if ("authorizeUrl" in err && (err as any).authorizeUrl != null) {
      result.authorizeUrl = (err as any).authorizeUrl;
    }
    if ("available" in err && (err as any).available != null) {
      result.available = (err as any).available;
    }
    return {
      isError: true,
      content: [{
        type: "text",
        text: JSON.stringify(result),
      }],
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{
      type: "text",
      text: JSON.stringify({
        error: "unknown_error",
        message,
        recoverable: false,
      }),
    }],
  };
}

// ============================================================================
// Tool handlers (exported for testing)
// ============================================================================

export async function handleReview(params: Record<string, unknown>): Promise<CallToolResult> {
  try {
    validateReviewParams(params);

    const prompt = typeof params.prompt === "string" ? params.prompt : undefined;
    const model = typeof params.model === "string" ? params.model : undefined;
    const base = typeof params.base === "string" ? params.base : undefined;
    const range = typeof params.range === "string" ? params.range : undefined;
    const count = typeof params.count === "number" ? params.count : undefined;
    const pr = typeof params.pr === "number" ? params.pr : undefined;

    const config = await loadConfig({ prompt, model });

    const diffOptions: DiffOptions = {
      mode: params.mode as DiffOptions["mode"],
      base,
      pr,
      range,
      count,
      ignorePaths: config.ignorePaths,
    };

    const reviewOptions: ReviewOptions = {
      diff: diffOptions,
      config,
      model,
    };

    const provider = await getProvider();
    const result = await review(reviewOptions, provider);

    const contentBlocks: Array<{ type: "text"; text: string }> = [
      {
        type: "text",
        text: JSON.stringify({
          content: result.content,
          model: result.model,
          usage: result.usage,
          diff: {
            filesChanged: result.diff.stats.filesChanged,
            insertions: result.diff.stats.insertions,
            deletions: result.diff.stats.deletions,
            files: result.diff.files.map((f) => ({ path: f.path, status: f.status })),
          },
          warnings: result.warnings,
        }),
      },
    ];

    const usageParts: string[] = [];
    if (result.usage) {
      usageParts.push(`Token usage: ${result.usage.totalTokens.toLocaleString("en-US")} tokens`);
    }
    usageParts.push(`Model: ${result.model}`);
    usageParts.push(`Files reviewed: ${result.diff.stats.filesChanged}`);

    contentBlocks.push({ type: "text", text: usageParts.join(" | ") });

    return { content: contentBlocks };
  } catch (err) {
    return mapErrorToToolResult(err);
  }
}

export async function handleChat(params: Record<string, unknown>): Promise<CallToolResult> {
  try {
    const message = typeof params.message === "string" ? params.message : "";
    const context = typeof params.context === "string" ? params.context : "";
    const modelOverride = typeof params.model === "string" ? params.model : undefined;

    const provider = await getProvider();

    // Resolve model
    let modelId: string;
    if (modelOverride) {
      modelId = modelOverride;
    } else if (provider.autoSelect) {
      modelId = await provider.autoSelect();
    } else {
      const models = await provider.listModels();
      if (models.length === 0) {
        throw new Error("No models available from provider");
      }
      modelId = models[0].id;
    }

    const chatResponse = await provider.chat({
      model: modelId,
      systemPrompt: context,
      messages: [{ role: "user", content: message }],
      stream: false,
    });

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          content: chatResponse.content,
          model: chatResponse.model,
          usage: chatResponse.usage,
        }),
      }],
    };
  } catch (err) {
    return mapErrorToToolResult(err);
  }
}

export async function handleModels(): Promise<CallToolResult> {
  try {
    const provider = await getProvider();
    const modelList = await provider.listModels();

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          models: modelList.map((m: ModelInfo) => ({
            id: m.id,
            name: m.name,
            endpoints: m.endpoints,
            streaming: m.streaming,
            toolCalls: m.toolCalls,
            maxPromptTokens: m.maxPromptTokens,
            maxOutputTokens: m.maxOutputTokens,
          })),
        }),
      }],
    };
  } catch (err) {
    return mapErrorToToolResult(err);
  }
}

// ============================================================================
// Server setup
// ============================================================================

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "llm-reviewer", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  // llm_review tool
  server.tool(
    "llm_review",
    "Review code changes using LLMs",
    {
      mode: z.enum(["unstaged", "staged", "local", "branch", "pr", "commits", "range"])
        .describe("Diff mode"),
      base: z.string().optional().describe("Base branch for branch mode"),
      pr: z.number().optional().describe("PR number for pr mode"),
      range: z.string().optional().describe("Ref range for range mode"),
      count: z.number().optional().describe("Commit count for commits mode"),
      model: z.string().optional().describe("Model override"),
      prompt: z.string().optional().describe("Prompt override"),
    },
    async (args) => {
      return await handleReview(args as Record<string, unknown>);
    },
  );

  // llm_chat tool
  server.tool(
    "llm_chat",
    "Chat with LLM about code",
    {
      message: z.string().describe("User's question"),
      context: z.string().optional().describe("Code/file content to include as context"),
      model: z.string().optional().describe("Model override"),
    },
    async (args) => {
      return await handleChat(args as Record<string, unknown>);
    },
  );

  // llm_models tool
  server.tool(
    "llm_models",
    "List available LLM models",
    {},
    async () => {
      return await handleModels();
    },
  );

  return server;
}

// ============================================================================
// Entry point
// ============================================================================

/**
 * Start the MCP server with stdio transport.
 * Called by the CLI's --mcp flag.
 */
export async function startServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Reset shared state (for testing)
export function _resetState(): void {
  _provider = null;
}
