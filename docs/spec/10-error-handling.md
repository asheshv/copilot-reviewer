# 10 — Error Handling

[Back to Spec Index](./README.md) | Prev: [09 — MCP Server](./09-mcp-server.md) | Next: [11 — Formatter](./11-formatter.md)

---

## Error Hierarchy

All errors extend a base class:

```typescript
class CopilotReviewError extends Error {
  code: string;              // machine-readable
  message: string;           // human-readable, actionable
  recoverable: boolean;      // should caller retry?
  cause?: Error;             // original error
}
```

## Error Types

### AuthError

| Code | When | Recoverable |
|------|------|-------------|
| `no_token` | All token sources exhausted | No |
| `token_expired` | Session token past `expires_at` | Yes (auto-refresh) |
| `exchange_failed` | Token exchange HTTP error | No |
| `model_auth` | 401 with `authorize_url` — model needs user auth | No |

Additional field: `authorizeUrl?: string` (for `model_auth`).

See [02 — Authentication](./02-authentication.md).

### DiffError

| Code | When | Recoverable |
|------|------|-------------|
| `empty_diff` | No changes found for the given mode | No |
| `not_git_repo` | cwd isn't inside a git repository | No |
| `base_not_found` | Base branch doesn't exist | No |
| `pr_not_found` | PR number is invalid | No |
| `gh_not_installed` | `gh` CLI not found (PR mode) | No |

See [03 — Diff Collection](./03-diff-collection.md).

### ClientError

| Code | When | Recoverable |
|------|------|-------------|
| `rate_limited` | HTTP 429 | Yes |
| `server_error` | HTTP 502/503/504 | Yes |
| `request_failed` | Other non-2xx | No |
| `stream_interrupted` | Stream died mid-response | No |

Additional fields: `status?: number`, `retryAfter?: number`.

See [04 — Copilot Client](./04-copilot-client.md).

### ConfigError

| Code | When | Recoverable |
|------|------|-------------|
| `malformed_json` | JSON parse failure | No |
| `invalid_field` | Schema validation fail | No |
| `prompt_not_found` | Prompt path in config doesn't exist | No |

Additional field: `filePath: string` (which config file).

See [06 — Configuration](./06-configuration.md).

### ModelError

| Code | When | Recoverable |
|------|------|-------------|
| `model_not_found` | Model ID not in available list | No |
| `auto_select_failed` | `/models/session` endpoint failed | No |

Additional field: `available?: string[]` (valid model IDs).

See [05 — Model Management](./05-model-management.md).

## Exit Code Mapping (CLI)

| Error Type | Exit Code |
|------------|-----------|
| Success (no HIGH findings) | 0 |
| HIGH severity findings | 1 |
| `AuthError` | 2 |
| `DiffError` | 3 |
| `ClientError` | 4 |
| `ModelError` | 4 |
| `ConfigError` | 5 |

See [08 — CLI](./08-cli.md) for full exit code table.

## MCP Error Mapping

All errors → structured tool result with `isError: true`:

```json
{
  "error": "<error.code>",
  "message": "<error.message>",
  "recoverable": "<error.recoverable>",
  "retryAfter": "<error.retryAfter, if applicable>",
  "authorizeUrl": "<error.authorizeUrl, if applicable>",
  "available": "<error.available, if applicable>",
  "raw": "<error.cause?.message>"
}
```

The MCP server never throws. See [09 — MCP Server](./09-mcp-server.md).

## Actionable Error Messages

Every error message tells the user what went wrong AND what to do about it:

| Code | Message |
|------|---------|
| `no_token` | "No GitHub token found. Either set $GITHUB_TOKEN, run `gh auth login`, or sign in to Copilot in your editor." |
| `empty_diff` | "No changes found for mode 'staged'. Did you mean 'unstaged' or 'local'?" |
| `rate_limited` | "Rate limited by GitHub Copilot API. Retry after 30 seconds." |
| `model_not_found` | "Model 'gpt-5-turbo' not found. Available: gpt-4.1, gpt-4o, claude-sonnet..." |
| `gh_not_installed` | "PR mode requires the GitHub CLI (gh). Install: https://cli.github.com/" |
| `not_git_repo` | "Not inside a git repository. Run from a git project directory." |
| `malformed_json` | "Failed to parse config: ~/.copilot-review/config.json — Unexpected token at line 5." |

## Design Principle

The `recoverable` flag is a first-class concern — AI agents use it to decide between retry, abort, or prompting the user. Rate limits and server errors are recoverable; auth and config errors require human intervention.
