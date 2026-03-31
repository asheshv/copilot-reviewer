# llm-reviewer

Review code changes using LLMs — CLI + MCP server for any AI agent. Supports GitHub Copilot and local Ollama models.

## Installation

```bash
# Install globally from GitHub
npm install -g github:asheshv/llm-reviewer

# Or use without installing:
npx --yes github:asheshv/llm-reviewer --help
```

## Quick Start

```bash
# Review uncommitted local changes (uses Copilot by default)
llm-reviewer

# Review changes in a feature branch vs main
llm-reviewer branch main

# Review a pull request
llm-reviewer pr 123

# Review with a local Ollama model
llm-reviewer local --provider ollama --model qwen2.5-coder:14b
```

## CLI Usage

```
llm-reviewer [mode] [options]

Modes (default: local):
  unstaged              Working tree vs index
  staged                Index vs HEAD
  local                 Working tree vs HEAD (default)
  branch [base]         Current branch vs base (default: main)
  pr <number>           Pull request diff
  commits <n>           Last N commits
  range <ref1>..<ref2>  Arbitrary ref range

Options:
  --model <id>          Model to use (default: auto)
  --format <fmt>        text | markdown | json (default: markdown)
  --stream              Force streaming output
  --no-stream           Force buffered output
  --prompt <text>       Override review prompt
  --config <path>       Override config file path
  --provider <name>     Review provider: copilot, ollama (default: copilot)
  --chunking <mode>     auto | always | never (default: auto)
  --timeout <seconds>   Request timeout (default: 30 for copilot, 120 for ollama)
  --ollama-url <url>    Ollama base URL (default: http://localhost:11434)
  --verbose             Enable debug logging to stderr
  --help                Show help
  --version             Show version

Subcommands:
  llm-reviewer models          List available models
  llm-reviewer chat "<msg>"    Free-form LLM chat
  llm-reviewer status          Show provider connectivity and configuration
```

### Examples

```bash
# Review staged changes before committing
llm-reviewer staged

# Review the last 3 commits
llm-reviewer commits 3

# Review a ref range
llm-reviewer range v1.0.0..HEAD

# Use a specific model with JSON output
llm-reviewer branch main --model gpt-4.1 --format json

# Custom review instructions
llm-reviewer --prompt "Focus on security and error handling"

# Review with Ollama (local LLM)
llm-reviewer local --provider ollama --model qwen2.5-coder:14b

# List Ollama models
llm-reviewer models --provider ollama

# Check provider status
llm-reviewer status --provider ollama

# Force chunking for large diffs
llm-reviewer branch main --chunking always

# Longer timeout for large models
llm-reviewer commits 1 --provider ollama --model qwen2.5-coder:32b --timeout 300
```

## Providers

### Copilot (default)

Uses GitHub Copilot's chat API. Requires a GitHub token (see [Authentication](#authentication)).

```bash
llm-reviewer local                          # auto-selects model
llm-reviewer local --model gpt-4.1          # specific model
llm-reviewer models                         # list available models
```

### Ollama (local)

Uses a locally running [Ollama](https://ollama.com) instance. No auth required.

```bash
# Start Ollama (if not running)
ollama serve

# List available models
llm-reviewer models --provider ollama

# Review with a specific model (model is required for Ollama)
llm-reviewer local --provider ollama --model qwen2.5-coder:14b

# Custom Ollama URL
llm-reviewer local --provider ollama --ollama-url http://remote:11434 --model codellama

# Non-streaming for cleaner output
llm-reviewer commits 1 --provider ollama --model qwen2.5-coder:14b --no-stream
```

### Status Command

Check provider connectivity, resolved configuration, and available models:

```bash
llm-reviewer status                         # default provider (copilot)
llm-reviewer status --provider ollama       # check Ollama
llm-reviewer status --json                  # machine-readable output
```

## Chunked Review

For large diffs that exceed the model's context window, `llm-reviewer` automatically splits the diff into chunks, reviews each independently, then aggregates findings via a reduce pass.

- **`auto`** (default) — chunks when diff exceeds 80% of model context
- **`always`** — always chunk, even small diffs
- **`never`** — fail if diff too large (useful for CI hard limits)

```bash
llm-reviewer branch main --chunking always   # force chunking
llm-reviewer branch main --chunking never    # disable chunking

# Kill switch via environment variable
LLM_REVIEWER_CHUNKING=never llm-reviewer local
```

Chunked reviews show progress on stderr:
```
Reviewing chunk 1/3 (src/auth.ts, src/config.ts)... done (3,200 tokens)
Reviewing chunk 2/3 (src/review.ts, src/prompt.ts)... done (2,800 tokens)
Reviewing chunk 3/3 (src/cli.ts)... done (1,950 tokens)
Aggregating findings... done (4,500 tokens)
```

## MCP Server Setup

The MCP server exposes LLM review capabilities as tools for AI agents (Claude Code, Cursor, Zed, Cline, etc.).

### For Claude Code

Add to `.mcp.json` in your project root or `~/.config/claude/mcp.json`:

```json
{
  "mcpServers": {
    "llm-reviewer": {
      "command": "llm-reviewer",
      "args": ["--mcp"]
    }
  }
}
```

### For Generic MCP Clients

```json
{
  "llm-reviewer": {
    "type": "stdio",
    "command": "llm-reviewer",
    "args": ["--mcp"]
  }
}
```

Or if using locally (not installed globally):

```json
{
  "llm-reviewer": {
    "type": "stdio",
    "command": "node",
    "args": ["/absolute/path/to/llm-reviewer/dist/cli.js", "--mcp"]
  }
}
```

### Available MCP Tools

- `llm_review` — Review code changes (all 7 modes supported)
- `llm_chat` — Free-form chat with LLM (with optional code context)
- `llm_models` — List available models

## Claude Code Skill

You can also add `llm-reviewer` as a [Claude Code skill](https://docs.anthropic.com/en/docs/claude-code/skills) so Claude can invoke it automatically when you ask for code review.

### Setup

```bash
# Copy the skill into your Claude skills directory
mkdir -p ~/.claude/skills/llm-reviewer
cp skills/SKILL.md ~/.claude/skills/llm-reviewer/SKILL.md
```

### Usage

Once installed, Claude Code will automatically use `llm-reviewer` when you:
- Ask to review code changes, diffs, or PRs
- Complete a feature and want a second opinion
- Request aggressive multi-round review

You can also invoke it explicitly:
```
/llm-reviewer
```

The skill supports all providers (Copilot, Ollama), chunking, cross-model review, and the full CLI feature set. See [`skills/SKILL.md`](skills/SKILL.md) for the complete reference.

## Configuration

Configuration is loaded from multiple layers (lowest to highest precedence):

1. **Built-in defaults** — Ships with the tool
2. **Environment variables** — `LLM_REVIEWER_*` (see below)
3. **Global config** — `~/.llm-reviewer/config.json` or `config.md`
4. **Project config** — `<git-root>/.llm-reviewer/config.json` or `config.md`
5. **CLI flags** — `--model`, `--format`, `--provider`, etc. (highest precedence)

### Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `LLM_REVIEWER_PROVIDER` | Override provider | `ollama` |
| `LLM_REVIEWER_OLLAMA_URL` | Ollama base URL | `http://remote:11434` |
| `LLM_REVIEWER_CHUNKING` | Chunking mode (kill switch) | `never` |

### config.json Schema

```json
{
  "model": "auto",
  "format": "markdown",
  "stream": true,
  "mode": "extend",
  "prompt": "path/to/custom-prompt.md",
  "defaultBase": "main",
  "ignorePaths": ["*.lock", "dist/**"],
  "provider": "copilot",
  "providerOptions": {
    "ollama": {
      "baseUrl": "http://localhost:11434"
    }
  },
  "chunking": "auto",
  "timeout": 30
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `model` | string | `"auto"` | Model ID or `"auto"` for automatic selection |
| `format` | string | `"markdown"` | Output format: `text`, `markdown`, or `json` |
| `stream` | boolean | `true` | Enable streaming output |
| `mode` | string | `"extend"` | Prompt merge strategy: `extend` or `replace` |
| `prompt` | string | — | Inline text or path to `.md` file (relative to config dir) |
| `defaultBase` | string | `"main"` | Default base branch for `branch` mode |
| `ignorePaths` | string[] | `[]` | Glob patterns to exclude from diffs (merged across layers) |
| `provider` | string | `"copilot"` | Review provider: `copilot` or `ollama` |
| `providerOptions` | object | `{}` | Provider-specific config (e.g., Ollama base URL) |
| `chunking` | string | `"auto"` | Chunking mode: `auto`, `always`, or `never` |
| `timeout` | number | `30` | Request timeout in seconds (auto: 120 for Ollama) |

### Prompt Customization

You can customize review instructions in two ways:

1. **Inline in config.json:**
   ```json
   {
     "mode": "extend",
     "prompt": "Focus on TypeScript type safety and error handling."
   }
   ```

2. **Separate config.md file:**
   ```markdown
   # Project-Specific Review Guidelines

   - Check React hooks dependencies
   - Verify error boundaries are present
   - Flag any `any` types
   ```

### Prompt Merge Modes

- **`"extend"`** (default) — Appends your instructions to the default prompt
- **`"replace"`** — Replaces the default prompt entirely with yours

Example multi-layer merge (all using `"extend"`):

```
[Default prompt from prompts/default-review.md]

## Additional Instructions (Global)
[Global ~/.llm-reviewer/config.md]

## Project Instructions
[Project .llm-reviewer/config.md]
```

If project config uses `"mode": "replace"`, only the project prompt is used.

CLI `--prompt` flag always replaces everything:

```bash
llm-reviewer --prompt "Only check for SQL injection"
```

## Default Review Prompt

The built-in prompt checks code changes in priority order:

1. **Security** — SQL injection, XSS, command injection, auth bypass, OWASP Top 10
2. **Correctness** — Edge cases, race conditions, error paths, invalid assumptions
3. **Performance** — N+1 queries, missing indexes, algorithmic complexity
4. **Readability** — Unclear naming, misleading comments, unnecessary complexity
5. **Simplicity** — Over-engineering, premature abstractions, YAGNI violations

Findings are categorized as HIGH, MEDIUM, or LOW severity. Security issues are always HIGH.

To customize, add a `config.md` file in `~/.llm-reviewer/` (global) or `<git-root>/.llm-reviewer/` (project).

## Output Formats

### Markdown (default)

```markdown
### HIGH SQL Injection in query builder
**File:** `src/db.ts` **Line:** 42
**Category:** Security

User input is concatenated directly into SQL query.

**Suggestion:**
Use parameterized queries instead...
```

### Text

Plain text output without markdown formatting. Suitable for terminals or tools that don't support markdown.

### JSON

Complete structured output in a single JSON object:

```json
{
  "review": {
    "content": "### HIGH SQL Injection...",
    "model": "gpt-4.1",
    "usage": { "totalTokens": 1234 }
  },
  "diff": {
    "filesChanged": 5,
    "insertions": 120,
    "deletions": 45,
    "files": [
      { "path": "src/db.ts", "status": "modified" }
    ]
  },
  "warnings": [],
  "exitCode": 1
}
```

For chunked reviews, usage includes a breakdown:
```json
"usage": {
  "totalTokens": 12450,
  "chunkedBreakdown": { "mapTokens": 7950, "reduceTokens": 4500, "chunks": 3 }
}
```

### NDJSON (Streaming JSON)

Use `--stream --format json` for newline-delimited JSON stream:

```bash
llm-reviewer --stream --format json | while read line; do
  echo "$line" | jq -r '.text // empty'
done
```

Each line is a valid JSON object. Enables real-time machine consumption of streaming output.

## Exit Codes

| Code | Meaning | Use Case |
|------|---------|----------|
| 0 | Success — no HIGH severity issues | Normal completion |
| 1 | Review completed with HIGH findings | CI gating: `llm-reviewer branch main \|\| exit 1` |
| 2 | Authentication failure | No GitHub token found |
| 3 | Diff error | Empty diff, not a git repo, etc. |
| 4 | API/model error | Rate limit, server error, model unavailable |
| 5 | Config error | Malformed config file |

### CI Integration Example

```bash
# Fail the build if high-severity issues are found
llm-reviewer branch main || exit 1

# Or capture the exit code
llm-reviewer branch main
if [ $? -eq 1 ]; then
  echo "High-severity issues found. Please review."
  exit 1
fi
```

## Authentication

GitHub token is resolved in priority order. First match wins.

1. **`$GITHUB_TOKEN` environment variable**
   ```bash
   export GITHUB_TOKEN="ghp_xxxxxxxxxxxx"
   llm-reviewer
   ```

2. **Copilot config files** (created by editor extensions)
   - `~/.config/github-copilot/hosts.json`
   - `~/.config/github-copilot/apps.json`

3. **GitHub CLI (`gh`)**
   ```bash
   gh auth login
   llm-reviewer
   ```

The tool automatically exchanges your OAuth token for a session token and caches it for subsequent requests.

**Note:** Authentication is only required for the Copilot provider. Ollama requires no auth.

### Setting Up Authentication

**Option 1: GitHub CLI (recommended)**

```bash
gh auth login
```

**Option 2: Environment Variable**

```bash
# Get a token from https://github.com/settings/tokens
# Scopes required: read:user, copilot
export GITHUB_TOKEN="ghp_xxxxxxxxxxxx"
```

**Option 3: Use Copilot Extension**

Sign in to GitHub Copilot in VS Code, Neovim, or JetBrains. The tool will use the cached token.

## Development

```bash
# Clone the repository
git clone https://github.com/asheshv/llm-reviewer.git
cd llm-reviewer

# Install dependencies
npm install

# Run tests
npm test

# Build the project
npm run build

# Run the CLI locally
node dist/cli.js --help

# Or link globally for testing
npm link
llm-reviewer --help
```

### Project Structure

```
llm-reviewer/
├── src/
│   ├── cli.ts                     # CLI entry point
│   ├── mcp-server.ts              # MCP server entry point
│   └── lib/
│       ├── providers/             # Provider abstraction layer
│       │   ├── types.ts           # ReviewProvider interface
│       │   ├── openai-chat-provider.ts  # Shared OpenAI-compatible base
│       │   ├── copilot-provider.ts      # GitHub Copilot provider
│       │   ├── ollama-provider.ts       # Ollama local provider
│       │   └── index.ts           # Provider factory
│       ├── auth.ts                # Token resolution + session exchange
│       ├── chunking.ts            # Diff splitting + bin-packing
│       ├── config.ts              # Multi-layer config loading
│       ├── diff.ts                # Git diff collection (7 modes)
│       ├── formatter.ts           # Output formatting (text/markdown/json)
│       ├── prompt.ts              # Prompt assembly + file manifests
│       ├── review.ts              # Review orchestration + map-reduce chunking
│       ├── streaming.ts           # SSE parser
│       ├── truncation.ts          # Severity-aware truncation for reduce pass
│       ├── types.ts               # Shared type definitions
│       └── index.ts               # Public API exports
├── test/                          # Tests (vitest + msw)
├── prompts/
│   └── default-review.md          # Built-in review prompt
├── skills/
│   └── SKILL.md                   # Claude Code skill definition
├── docs/
│   ├── spec/                      # Design specifications
│   ├── adr/                       # Architecture decision records
│   ├── plans/                     # Implementation plans
│   └── reference/                 # API documentation
└── .llm-reviewer/                 # Project-level config (dogfooding)
    ├── config.json
    └── config.md
```

## License

MIT License. See [LICENSE](./LICENSE) for details.

---

**Questions or issues?** Open an issue on [GitHub](https://github.com/asheshv/llm-reviewer).
