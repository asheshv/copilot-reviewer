// src/lib/index.ts

// Types and error classes
export * from "./types.js";

// Auth
export { createDefaultAuthProvider, getAuthenticatedHeaders, resolveToken, exchangeSessionToken, clearSessionCache } from "./auth.js";

// Client
export { CopilotClient } from "./client.js";

// Streaming
export { parseSSEStream, parseChatCompletionChunk, parseResponsesChunk } from "./streaming.js";

// Models
export { ModelManager } from "./models.js";

// Diff
export { collectDiff } from "./diff.js";

// Config
export { loadConfig } from "./config.js";

// Prompt
export { loadBuiltInPrompt, assembleUserMessage } from "./prompt.js";

// Formatter
export { format, formatNdjsonChunk, detectHighSeverity } from "./formatter.js";

// Review
export { review, reviewStream } from "./review.js";
