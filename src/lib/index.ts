// src/lib/index.ts

// Types and error classes
export * from "./types.js";

// Auth
export { createDefaultAuthProvider, getAuthenticatedHeaders, resolveToken, exchangeSessionToken, clearSessionCache } from "./auth.js";

// Streaming
export { parseSSEStream, parseChatCompletionChunk, parseResponsesChunk } from "./streaming.js";

// Providers
export { createProvider, availableProviders } from "./providers/index.js";
export type { ReviewProvider } from "./providers/types.js";
export { CopilotProvider } from "./providers/copilot-provider.js";
export { OpenAIChatProvider } from "./providers/openai-chat-provider.js";
export { OllamaProvider } from "./providers/ollama-provider.js";

// Diff
export { collectDiff } from "./diff.js";

// Config
export { loadConfig } from "./config.js";

// Prompt
export { loadBuiltInPrompt, assembleUserMessage, assembleChunkMessage, assembleReduceMessage, getReduceSystemPrompt } from "./prompt.js";

// Formatter
export { format, formatNdjsonChunk, detectHighSeverity } from "./formatter.js";

// Review
export { review, reviewStream, shouldChunk } from "./review.js";
