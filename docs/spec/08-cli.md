# 08 — CLI

[Back to Spec Index](./README.md) | Prev: [07 — Review Orchestration](./07-review-orchestration.md) | Next: [09 — MCP Server](./09-mcp-server.md)

---

## Binary Name

`llm-reviewer` — registered in `package.json` `bin` field.

## Usage

```
llm-reviewer [mode] [options]

Modes (default: local):
  unstaged              Working tree vs index
  staged                Index vs HEAD
  local                 Working tree vs HEAD
  branch [base]         Current branch vs base (default: main)
  pr <number>           Pull request diff
  commits <n>           Last N commits
  range <ref1>..<ref2>  Arbitrary ref range

Options:
  --model <id>       Model to use (default: auto)
  --format <fmt>     text | markdown | json (default: markdown)
  --stream           Force streaming output
  --no-stream        Force buffered output
  --prompt <text>    Override review prompt
  --config <path>    Override config file path (replaces project config layer)
  --verbose          Enable debug logging to stderr
  --help             Show help
  --version          Show version

Subcommands:
  llm-reviewer models          List available models
  llm-reviewer chat "<msg>"    Free-form LLM chat
```

## Exit Codes

| Code | Meaning | Use case |
|------|---------|----------|
| 0 | Success — no HIGH severity issues | Normal completion |
| 1 | Review completed with HIGH severity findings | CI gating: `llm-reviewer branch main \|\| exit 1` |
| 2 | Auth failure | See [02 — Authentication](./02-authentication.md) |
| 3 | Diff error (empty, not a git repo, etc.) | See [03 — Diff Collection](./03-diff-collection.md) |
| 4 | API/model error (rate limit, server error) | See [10 — Error Handling](./10-error-handling.md) |
| 5 | Config error (malformed config file) | See [06 — Configuration](./06-configuration.md) |

Exit code 1 enables CI integration without extra scripting.

## Output Behavior

### stdout vs stderr

| Channel | Content |
|---------|---------|
| **stdout** | Review content only (all formats) |
| **stderr** | Progress messages, warnings, errors |

This separation enables clean piping: `llm-reviewer branch main > review.md`.

### Progress Messages (stderr)

```
Authenticating... done
Collecting diff (5 files, +120/-45)...
Requesting review from gpt-4.1...
```

### Streaming (text/markdown)

Progress on stderr, review content streamed to stdout as it arrives from Copilot.

### Buffered (json)

Progress on stderr, single JSON object on stdout when complete.

## TTY Detection

When stdout is not a TTY (piped):
- Suppress color
- Default format switches to `json`

Explicit `--format` always overrides TTY detection.

## Streaming Defaults

| Format | Default streaming | Rationale |
|--------|-------------------|-----------|
| markdown | stream | Human watching — show results as they arrive |
| text | stream | Same |
| json | buffered | Machine consuming — needs complete object |

`--stream` / `--no-stream` flags always override.

### Conflict: `--stream` + `--format json`

`--stream --format json` is a **valid** combination. Output is newline-delimited JSON (NDJSON) — one JSON object per `StreamChunk`. This enables real-time machine consumption of streaming output (e.g., piping to a monitoring tool).

## Subcommands

### `llm-reviewer models`

Lists available models. See [05 — Model Management](./05-model-management.md).

### `llm-reviewer chat "<message>"`

Free-form LLM chat. **Single-turn only** — send message, print response, exit. Not an interactive chat loop. Uses the same auth and client infrastructure.

**System prompt:** None (empty string). The review prompt is NOT used for chat — it would confuse the model. The user's message is the entire input. If the user needs a system prompt, they can prefix their message with instructions.

For multi-turn conversations, use a full MCP client (which can call the `llm_chat` tool repeatedly with conversation history).

## Default Mode

`llm-reviewer` with no mode argument defaults to `local` mode (equivalent to `llm-reviewer local`). This is the most common use case: "show me what I've been working on."

## Verbose / Debug Mode

`--verbose` flag or `DEBUG=llm-reviewer` environment variable enables debug logging to stderr. See [07 — Review Orchestration](./07-review-orchestration.md) for what's logged.

## Argument Parser

`commander` or `yargs` — decision deferred to implementation time. Both are mature and capable. Key requirement: subcommand support + positional arguments for modes.

## Entry Point Modes

The `llm-reviewer` binary can run in two modes:
- **Default:** CLI review tool (this spec)
- **`--mcp`:** Start as MCP server (see [09 — MCP Server](./09-mcp-server.md))

This allows a single binary for both use cases. When `--mcp` is passed, the CLI delegates to `mcp-server.ts` and enters stdio transport mode.
