# 09 — MCP Server

[Back to Spec Index](./README.md) | Prev: [08 — CLI](./08-cli.md) | Next: [10 — Error Handling](./10-error-handling.md)

---

## Overview

The MCP server exposes LLM capabilities as tools consumable by any MCP-compatible AI agent (Claude Code, Cursor, Zed, Cline, etc.). It imports `lib/` directly — no process spawning.

## Transport

**stdio** — standard for CLI-based MCP servers.

## Tools

### `llm_review`

Review code changes using LLMs.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `mode` | enum | yes | `unstaged\|staged\|local\|branch\|pr\|commits\|range` |
| `base` | string | no | Base branch for `branch` mode |
| `pr` | number | no | PR number for `pr` mode |
| `range` | string | no | Ref range for `range` mode |
| `count` | number | no | Commit count for `commits` mode |
| `model` | string | no | Model override |
| `prompt` | string | no | Prompt override |

**Success response:**

```json
{
  "content": "<review in markdown>",
  "model": "gpt-4.1",
  "usage": { "totalTokens": 1234 },
  "diff": {
    "filesChanged": 5,
    "insertions": 120,
    "deletions": 45,
    "files": [
      { "path": "src/auth.ts", "status": "modified" }
    ]
  },
  "warnings": []
}
```

**Error response:**

```json
{
  "error": "no_token",
  "message": "No GitHub token found. Set $GITHUB_TOKEN or run gh auth login.",
  "recoverable": false,
  "raw": "<underlying error details>"
}
```

See [10 — Error Handling](./10-error-handling.md) for all error codes.

---

### `llm_chat`

Chat with LLM about code.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `message` | string | yes | User's question |
| `context` | string | no | Code/file content to include as context |
| `model` | string | no | Model override |

**Response:**

```json
{
  "content": "<Copilot's response>",
  "model": "gpt-4.1",
  "usage": { "totalTokens": 567 }
}
```

The optional `context` parameter lets agents pass in file contents or code snippets alongside a question without constructing the full prompt themselves.

**Implementation:** Calls `client.chat()` directly:
- `systemPrompt`: the `context` parameter if provided, otherwise empty string. The review prompt is NOT used for chat.
- `messages`: `[{ role: "user", content: message }]`
- `model`: resolved via auto-selection or explicit override

---

### `llm_models`

List available LLM models.

**Parameters:** none

**Response:**

```json
{
  "models": [
    {
      "id": "gpt-4.1",
      "name": "GPT 4.1",
      "endpoints": ["/chat/completions", "/responses"],
      "streaming": true,
      "toolCalls": true,
      "maxPromptTokens": 128000,
      "maxOutputTokens": 16384
    }
  ]
}
```

See [05 — Model Management](./05-model-management.md) for details on model listing and filtering.

---

## Key Behaviors

| Behavior | Rationale |
|----------|-----------|
| Always uses `lib/` directly | No process spawn overhead |
| Always non-streaming | MCP protocol doesn't support streaming tool results |
| `stream` config setting is ignored | Always uses `review()` (buffered), never `reviewStream()` |
| Respects global + project config | Inherits `cwd` from MCP client for project detection |
| Never throws | Errors returned as structured objects with `isError: true` on MCP `ToolResult` |
| Server is long-lived | Session token cached across multiple tool invocations |
| Sequential tool call handling | Tool calls are processed one at a time (no parallelism) to avoid race conditions on shared state (auth cache, model cache) |

## Parameter Validation

Before calling `lib/`, the MCP server validates tool parameters:

| Validation | Error |
|------------|-------|
| Invalid `mode` enum value | `{ error: "invalid_parameter", message: "Invalid mode '...'. Valid: unstaged, staged, local, branch, pr, commits, range" }` |
| `pr` mode without `pr` parameter | `{ error: "missing_parameter", message: "Mode 'pr' requires 'pr' parameter (PR number)" }` |
| `range` mode without `range` parameter | `{ error: "missing_parameter", message: "Mode 'range' requires 'range' parameter" }` |
| `commits` mode without `count` parameter | `{ error: "missing_parameter", message: "Mode 'commits' requires 'count' parameter" }` |

Tool definitions should use JSON Schema `enum` constraints for `mode` to prevent invalid values at the protocol level.

## Tool-to-ReviewOptions Mapping

The MCP server bridges flat tool parameters to `ReviewOptions`:

```typescript
// llm_review tool handler:
const config = loadConfig({ prompt: params.prompt, model: params.model });
const reviewOptions: ReviewOptions = {
  diff: {
    mode: params.mode,
    base: params.base,
    pr: params.pr,
    range: params.range,
    count: params.count,
    ignorePaths: config.ignorePaths,
  },
  config,
  model: params.model,
};
const result = await review(reviewOptions);
```

## MCP Client Configuration

For consumers to register this server:

```json
{
  "llm-reviewer": {
    "type": "stdio",
    "command": "node",
    "args": ["path/to/dist/mcp-server.js"]
  }
}
```

Or if installed globally (uses the `--mcp` flag — see [08 — CLI](./08-cli.md)):

```json
{
  "llm-reviewer": {
    "type": "stdio",
    "command": "llm-review",
    "args": ["--mcp"]
  }
}
```
