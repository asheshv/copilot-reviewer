---
name: llm-reviewer
description: Review code changes using LLMs (Copilot, Ollama, or other providers). Use when asked to review code, diffs, PRs, or when completing a feature and wanting a second opinion.
---

# LLM Code Review

Use `npx github:asheshv/llm-reviewer` to get an AI-powered code review from any supported LLM provider.

## When to Use

- User asks to review code changes, diffs, or PRs
- After completing a feature, before committing or creating a PR
- When you want a second opinion on code quality, security, or correctness
- For aggressive multi-round review iterations
- When reviewing large diffs that need chunking (auto-handled)

## Commands

Run via the Bash tool. Always use `--format json` for structured output you can parse and summarize.

### Basic Review (Copilot — default provider)

```bash
# Review local uncommitted changes (default mode)
npx --yes github:asheshv/llm-reviewer --format json

# Review only staged changes
npx github:asheshv/llm-reviewer staged --format json

# Review current branch vs main
npx github:asheshv/llm-reviewer branch main --format json

# Review a specific PR
npx github:asheshv/llm-reviewer pr 123 --format json

# Review last N commits
npx github:asheshv/llm-reviewer commits 3 --format json

# Review arbitrary ref range
npx github:asheshv/llm-reviewer range abc123..def456 --format json

# Use a specific model
npx github:asheshv/llm-reviewer --model gpt-4.1 --format json
```

### Ollama (Local LLM Review)

```bash
# List available Ollama models
npx github:asheshv/llm-reviewer models --provider ollama

# Review with a specific Ollama model
npx github:asheshv/llm-reviewer local --provider ollama --model qwen2.5-coder:14b --format json

# Review with custom Ollama URL
npx github:asheshv/llm-reviewer local --provider ollama --ollama-url http://remote:11434 --model codellama --format json

# Review last commit with Ollama (non-streaming for cleaner output)
npx github:asheshv/llm-reviewer commits 1 --provider ollama --model qwen2.5-coder:14b --no-stream --format json

# Ollama with longer timeout (default: 120s for Ollama, 30s for Copilot)
npx github:asheshv/llm-reviewer commits 1 --provider ollama --model qwen2.5-coder:32b --timeout 300 --format json
```

### Status & Diagnostics

```bash
# Check provider connectivity and configuration
npx github:asheshv/llm-reviewer status

# Check Ollama status specifically
npx github:asheshv/llm-reviewer status --provider ollama

# Status as JSON (for programmatic use)
npx github:asheshv/llm-reviewer status --json

# List available models (default provider)
npx github:asheshv/llm-reviewer models

# List Ollama models
npx github:asheshv/llm-reviewer models --provider ollama
```

### Chunking Control

```bash
# Force chunking even for small diffs (useful for testing)
npx github:asheshv/llm-reviewer local --chunking always --format json

# Disable chunking (fail if diff too large)
npx github:asheshv/llm-reviewer local --chunking never --format json

# Auto (default) — chunks when diff exceeds 80% of model context
npx github:asheshv/llm-reviewer local --format json
```

### Aggressive Review Pattern (Multiple Rounds)

For thorough code review, run multiple rounds until no HIGH/MEDIUM issues remain:

```bash
# Round 1: review last 3 commits
npx github:asheshv/llm-reviewer commits 3 --format json --no-stream 2>/dev/null

# If exitCode: 1 (HIGH findings), fix issues and re-review
# Repeat until exitCode: 0

# Cross-model review (Copilot first, then Ollama for a second opinion)
npx github:asheshv/llm-reviewer commits 3 --format json --no-stream 2>/dev/null
npx github:asheshv/llm-reviewer commits 3 --provider ollama --model qwen2.5-coder:14b --format json --no-stream 2>/dev/null
```

## Interpreting Results

JSON output structure:
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
    "files": [...]
  },
  "warnings": [],
  "exitCode": 0
}
```

### Chunked review output (large diffs)

When chunking activates, the JSON includes a breakdown:
```json
{
  "review": {
    "content": "### HIGH ...",
    "model": "gpt-4.1",
    "usage": {
      "totalTokens": 12450,
      "chunkedBreakdown": { "mapTokens": 7950, "reduceTokens": 4500, "chunks": 3 }
    }
  }
}
```

### Exit Codes

- `exitCode: 0` — no HIGH severity findings
- `exitCode: 1` — HIGH severity findings detected
- `exitCode: 2` — authentication error (set $GITHUB_TOKEN or run `gh auth login`)
- `exitCode: 3` — diff error (empty diff, not a git repo, etc.)
- `exitCode: 4` — API error (rate limited, model not found, etc.)
- `exitCode: 5` — configuration error

## How to Present Results

1. Parse the JSON output
2. Summarize the key findings by severity (HIGH > MEDIUM > LOW)
3. Quote specific file:line references from the review
4. If `exitCode: 1`, highlight the HIGH severity issues prominently
5. If warnings are present, mention them
6. If chunked, note: "Review was split into N chunks due to diff size"
7. Suggest next steps (fix issues, or proceed if clean)

## Environment Variables

```bash
# Override provider without CLI flag
LLM_REVIEWER_PROVIDER=ollama

# Override Ollama URL
LLM_REVIEWER_OLLAMA_URL=http://remote:11434

# Disable chunking (kill switch)
LLM_REVIEWER_CHUNKING=never
```

## Prerequisites

Requires a GitHub token for Copilot provider. The tool checks in order:
1. `$GITHUB_TOKEN` environment variable
2. GitHub Copilot editor config files
3. `gh auth token` (GitHub CLI)

For Ollama provider: no auth needed, just a running Ollama instance.
