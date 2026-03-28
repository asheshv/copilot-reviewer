// src/mcp-server.ts

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  CopilotReviewError,
  ParameterError,
  type ReviewOptions,
  type DiffOptions,
  type ModelInfo,
} from "./lib/types.js";
import { review } from "./lib/review.js";
import { loadConfig } from "./lib/config.js";
import { createDefaultAuthProvider } from "./lib/auth.js";
import { CopilotClient } from "./lib/client.js";
import { ModelManager } from "./lib/models.js";

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

let _auth: ReturnType<typeof createDefaultAuthProvider> | null = null;
let _client: CopilotClient | null = null;
let _models: ModelManager | null = null;

function getAuth(): ReturnType<typeof createDefaultAuthProvider> {
  if (!_auth) {
    _auth = createDefaultAuthProvider();
  }
  return _auth;
}

function getClient(): CopilotClient {
  if (!_client) {
    _client = new CopilotClient(getAuth());
  }
  return _client;
}

function getModelManager(): ModelManager {
  if (!_models) {
    _models = new ModelManager(getAuth());
  }
  return _models;
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
  if (err instanceof CopilotReviewError) {
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

    const config = await loadConfig({
      prompt: params.prompt as string | undefined,
      model: params.model as string | undefined,
    });

    const diffOptions: DiffOptions = {
      mode: params.mode as DiffOptions["mode"],
      base: params.base as string | undefined,
      pr: params.pr as number | undefined,
      range: params.range as string | undefined,
      count: params.count as number | undefined,
      ignorePaths: config.ignorePaths,
    };

    const reviewOptions: ReviewOptions = {
      diff: diffOptions,
      config,
      model: params.model as string | undefined,
    };

    const client = getClient();
    const models = getModelManager();
    const result = await review(reviewOptions, client, models);

    return {
      content: [
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
        {
          type: "text",
          text: `Token usage: ${result.usage.totalTokens.toLocaleString("en-US")} tokens | Model: ${result.model} | Files reviewed: ${result.diff.stats.filesChanged}`,
        },
      ],
    };
  } catch (err) {
    return mapErrorToToolResult(err);
  }
}

export async function handleChat(params: Record<string, unknown>): Promise<CallToolResult> {
  try {
    const message = params.message as string;
    const context = (params.context as string) || "";
    const modelOverride = params.model as string | undefined;

    const client = getClient();
    const models = getModelManager();

    // Resolve model
    let modelId: string;
    if (modelOverride) {
      modelId = modelOverride;
    } else {
      modelId = await models.autoSelect();
    }

    const info = await models.validateModel(modelId);
    const useResponsesApi = info.endpoints.includes("/responses");

    const chatResponse = await client.chat(
      {
        model: modelId,
        systemPrompt: context,
        messages: [{ role: "user", content: message }],
        stream: false,
      },
      useResponsesApi,
    );

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
    const models = getModelManager();
    const modelList = await models.listModels();

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
    { name: "copilot-reviewer", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // copilot_review tool
  server.tool(
    "copilot_review",
    "Review code changes using GitHub Copilot",
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

  // copilot_chat tool
  server.tool(
    "copilot_chat",
    "Chat with GitHub Copilot about code",
    {
      message: z.string().describe("User's question"),
      context: z.string().optional().describe("Code/file content to include as context"),
      model: z.string().optional().describe("Model override"),
    },
    async (args) => {
      return await handleChat(args as Record<string, unknown>);
    },
  );

  // copilot_models tool
  server.tool(
    "copilot_models",
    "List available GitHub Copilot models",
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
  _auth = null;
  _client = null;
  _models = null;
}
