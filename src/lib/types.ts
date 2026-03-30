// src/lib/types.ts

/**
 * Base error class for all copilot-reviewer errors.
 * Extends Error with code, recoverable flag, and optional cause.
 */
export class CopilotReviewError extends Error {
  code: string;
  recoverable: boolean;
  cause?: Error;

  constructor(code: string, message: string, recoverable: boolean, cause?: Error) {
    super(message);
    this.code = code;
    this.recoverable = recoverable;
    this.cause = cause;
    this.name = "CopilotReviewError";
  }
}

/**
 * Authentication-related errors (e.g., missing token, expired credentials).
 */
export class AuthError extends CopilotReviewError {
  authorizeUrl?: string;

  constructor(code: string, message: string, recoverable: boolean, cause?: Error) {
    super(code, message, recoverable, cause);
    this.name = "AuthError";
  }
}

/**
 * Diff generation errors (e.g., empty diff, no repository).
 */
export class DiffError extends CopilotReviewError {
  constructor(code: string, message: string, recoverable = false, cause?: Error) {
    super(code, message, recoverable, cause);
    this.name = "DiffError";
  }
}

/**
 * HTTP client errors (e.g., rate limiting, network failures).
 */
export class ClientError extends CopilotReviewError {
  status?: number;
  retryAfter?: number;

  constructor(code: string, message: string, recoverable: boolean, cause?: Error) {
    super(code, message, recoverable, cause);
    this.name = "ClientError";
  }
}

/**
 * Configuration file errors (e.g., malformed JSON, invalid values).
 */
export class ConfigError extends CopilotReviewError {
  filePath: string;

  constructor(code: string, message: string, filePath: string, recoverable = false, cause?: Error) {
    super(code, message, recoverable, cause);
    this.filePath = filePath;
    this.name = "ConfigError";
  }
}

/**
 * Model-related errors (e.g., model not found, unsupported model).
 */
export class ModelError extends CopilotReviewError {
  available?: string[];

  constructor(code: string, message: string, recoverable: boolean, cause?: Error) {
    super(code, message, recoverable, cause);
    this.name = "ModelError";
  }
}

/**
 * Review orchestration errors (e.g., diff too large, no findings).
 */
export class ReviewError extends CopilotReviewError {
  suggestion?: string;

  constructor(code: string, message: string, recoverable: boolean, cause?: Error) {
    super(code, message, recoverable, cause);
    this.name = "ReviewError";
  }
}

/**
 * CLI parameter validation errors (e.g., missing required parameter, conflicting options).
 */
export class ParameterError extends CopilotReviewError {
  constructor(code: string, message: string, recoverable = false, cause?: Error) {
    super(code, message, recoverable, cause);
    this.name = "ParameterError";
  }
}

// ============================================================================
// Auth Types
// ============================================================================

/**
 * Authentication provider interface for obtaining authenticated HTTP headers.
 */
export interface AuthProvider {
  getAuthenticatedHeaders(): Promise<Record<string, string>>;
}

// ============================================================================
// Message Types
// ============================================================================

/**
 * Chat message for the Copilot API.
 */
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

/**
 * Tool call information in a message.
 */
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

// ============================================================================
// Client Types
// ============================================================================

/**
 * Request payload for the chat API.
 */
export interface ChatRequest {
  model: string;
  systemPrompt: string;
  messages: Message[];
  stream: boolean;
  maxTokens?: number;
}

/**
 * Response from the chat API (non-streaming).
 */
export interface ChatResponse {
  content: string;
  model: string;
  usage: { totalTokens: number };
}

/**
 * Chunk from a streaming response.
 */
export interface StreamChunk {
  type: "content" | "reasoning" | "error" | "done" | "warning";
  text?: string;
  usage?: { totalTokens: number };
  model?: string;
}

// ============================================================================
// Model Types
// ============================================================================

/**
 * Metadata about a Copilot model.
 */
export interface ModelInfo {
  id: string;
  name: string;
  endpoints: string[];
  streaming: boolean;
  toolCalls: boolean;
  maxPromptTokens: number;
  maxOutputTokens: number;
  tokenizer: string;
}

// ============================================================================
// Diff Types
// ============================================================================

/**
 * Options for generating a diff.
 */
export interface DiffOptions {
  mode: "unstaged" | "staged" | "local" | "branch" | "pr" | "commits" | "range";
  base?: string;
  pr?: number;
  range?: string;
  count?: number;
  ignorePaths?: string[];
}

/**
 * Result of a diff operation.
 */
export interface DiffResult {
  raw: string;
  files: FileChange[];
  stats: {
    filesChanged: number;
    insertions: number;
    deletions: number;
  };
}

/**
 * Metadata about a single file change.
 */
export interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  oldPath?: string;
  insertions: number;
  deletions: number;
}

// ============================================================================
// Output Types
// ============================================================================

/**
 * Output format for review results.
 */
export type OutputFormat = "text" | "markdown" | "json";

// ============================================================================
// Config Types
// ============================================================================

/**
 * Structure of the config file on disk.
 */
export interface ConfigFile {
  model?: string;
  format?: OutputFormat;
  stream?: boolean;
  mode?: "extend" | "replace";
  prompt?: string;
  defaultBase?: string;
  ignorePaths?: string[];
  provider?: string;
  providerOptions?: {
    ollama?: { baseUrl?: string };
    [key: string]: Record<string, unknown> | undefined;
  };
  chunking?: "auto" | "always" | "never";
}

/**
 * Fully resolved configuration after merging defaults, file, and CLI overrides.
 */
export interface ResolvedConfig {
  model: string;
  format: OutputFormat;
  stream: boolean;
  prompt: string;
  defaultBase: string;
  ignorePaths: string[];
  provider: string;
  providerOptions: {
    ollama?: { baseUrl: string };
    [key: string]: Record<string, unknown> | undefined;
  };
  chunking: "auto" | "always" | "never";
}

/**
 * CLI-provided overrides for configuration.
 */
export interface CLIOverrides {
  prompt?: string;
  model?: string;
  format?: OutputFormat;
  stream?: boolean;
  config?: string;
  provider?: string;
  chunking?: "auto" | "always" | "never";
  ollamaUrl?: string;
}

// ============================================================================
// Review Types
// ============================================================================

/**
 * Options for performing a review.
 */
export interface ReviewOptions {
  diff: DiffOptions;
  config: ResolvedConfig;
  model?: string;
}

/**
 * Result of a non-streaming review.
 */
export interface ReviewResult {
  content: string;
  model: string;
  usage: { totalTokens: number };
  diff: DiffResult;
  warnings: string[];
}

/**
 * Result of a streaming review.
 */
export interface ReviewStreamResult {
  stream: AsyncIterable<string>;
  warnings: string[];
  diff: DiffResult;
  model: string;
  /** Populated after the stream has been fully consumed. */
  usage?: { totalTokens: number };
}

// ============================================================================
// Status Types
// ============================================================================

/**
 * JSON output for the `status` command.
 */
export interface StatusOutput {
  provider: string;
  model: {
    configured: string;       // "auto" or explicit model ID
    resolved: string | null;  // actual model ID after auto-select, null if failed/unavailable
  };
  chunking: "auto" | "always" | "never";
  stream: boolean;
  format: string;
  config: {
    global: { path: string; found: boolean; fallback?: string; fallbackFound?: boolean };
    project: { path: string; found: boolean; fallback?: string; fallbackFound?: boolean };
  };
  auth: {
    method: string;     // "env_token" | "copilot_config" | "gh_cli" | "none"
    valid: boolean;
    error?: string;
  };
  api: {
    reachable: boolean;
    latencyMs: number | null;
    error?: string;
  };
  models: string[] | null;        // null when unreachable
  modelsError: string | null;     // null when succeeded
  healthy: boolean;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Exit codes for the CLI.
 */
export const EXIT_CODES = {
  SUCCESS: 0,
  HIGH_SEVERITY: 1,
  AUTH_ERROR: 2,
  DIFF_ERROR: 3,
  API_ERROR: 4,
  MODEL_ERROR: 4,
  CONFIG_ERROR: 5,
} as const;
