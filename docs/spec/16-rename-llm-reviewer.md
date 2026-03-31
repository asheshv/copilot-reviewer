# 16 — Rename: copilot-reviewer → llm-reviewer

[Back to Spec Index](./README.md) | Previous: [15 — Multi-Provider & Chunked Review](./15-multi-provider-and-chunked-review.md)

---

## Overview

Rename the tool from `copilot-reviewer` to `llm-reviewer` to reflect multi-provider support (Copilot, Ollama, future LLMs). Bump version to `1.0.0`. Rename the GitHub repo. No functional changes.

## Rename Map

| Item | Old | New |
|------|-----|-----|
| Package name (`package.json`) | `copilot-reviewer` | `llm-reviewer` |
| CLI binary (`package.json` bin) | `copilot-review` | `llm-review` |
| Version | `0.1.0` | `1.0.0` |
| GitHub repo | `asheshv/copilot-reviewer` | `asheshv/llm-reviewer` |
| Config dir (global) | `~/.code-reviewer/` | `~/.llm-reviewer/` |
| Config dir (project) | `.code-reviewer/` | `.llm-reviewer/` |
| Dogfood config (this repo) | `.copilot-review/` | `.llm-reviewer/` |
| Fallback config dirs | none | none (clean cut, no backward-compat chain) |
| Env var: provider | `CODEREVIEWER_PROVIDER` | `LLM_REVIEWER_PROVIDER` |
| Env var: Ollama URL | `CODEREVIEWER_OLLAMA_URL` | `LLM_REVIEWER_OLLAMA_URL` |
| Env var: chunking | `CODEREVIEWER_CHUNKING` | `LLM_REVIEWER_CHUNKING` |
| MCP server name | `copilot-reviewer` | `llm-reviewer` |
| CLI description | "Review code changes using GitHub Copilot" | "Review code changes using LLMs" |
| Formatter headers | "Copilot Code Review" | "LLM Code Review" |
| Editor-Version header | `copilot-reviewer/0.1.0` | `llm-reviewer/1.0.0` |
| Editor-Plugin-Version header | `copilot-reviewer/0.1.0` | `llm-reviewer/1.0.0` |
| Debug env check | `DEBUG === "copilot-review"` | `DEBUG === "llm-review"` |
| Entry point detection | `copilot-review` in argv | `llm-review` in argv |

## What Does NOT Change

- Provider names: `"copilot"`, `"ollama"` — these are provider identifiers, not tool names
- `AuthProvider` interface or auth logic
- Copilot API headers: `Copilot-Integration-Id: vscode-chat`, `x-github-api-version` — these are API requirements
- Default provider: `"copilot"` (unchanged)
- Any functional behavior, algorithms, or test logic

## Files Affected

### Source (string replacements)

| File | Changes |
|------|---------|
| `package.json` | name, version, bin, description |
| `src/cli.ts` | CLI name, description, debug env, entry point detection, error messages, `VERSION` constant |
| `src/mcp-server.ts` | server name/version string |
| `src/lib/config.ts` | config dir paths (`~/.llm-reviewer/`, `.llm-reviewer/`), env var names (`LLM_REVIEWER_*`), warning messages |
| `src/lib/formatter.ts` | "Copilot Code Review" → "LLM Code Review" |
| `src/lib/providers/copilot-provider.ts` | `Editor-Version`, `Editor-Plugin-Version` header values |
| `src/lib/providers/openai-chat-provider.ts` | no changes expected (no hardcoded tool name) |
| `src/mcp-server.ts` (tools) | MCP tool names: `copilot_review` → `llm_review`, `copilot_chat` → `llm_chat`, `copilot_models` → `llm_models` |

### Tests (string replacements)

All test files containing hardcoded references to:
- `"copilot-review"` (CLI name)
- `"copilot-reviewer"` (package/MCP name)
- `"Copilot Code Review"` (formatter header)
- `CODEREVIEWER_*` (env var names)
- `.code-reviewer/` or `.copilot-review/` (config paths)

### Config

| Old path | New path |
|----------|----------|
| `.copilot-review/config.json` | `.llm-reviewer/config.json` |
| `.copilot-review/config.md` | `.llm-reviewer/config.md` |

Rename the directory in this repo (dogfood config).

### Docs

All markdown files in `docs/` with references to old names. Bulk find-and-replace, preserving meaning.

### README

Full update: tool name, installation instructions, CLI examples, config paths, env var names.

## GitHub Repo Rename

1. Go to GitHub → Settings → rename `copilot-reviewer` → `llm-reviewer`
2. GitHub auto-redirects the old URL
3. Update local git remote:
```bash
git remote set-url origin git@github.com:asheshv/llm-reviewer.git
```

## Implementation Approach

Pure find-and-replace. No logic changes. One commit for all source/test/config changes. Separate manual step for GitHub repo rename.

### Replacement Rules (in order)

1. `CODEREVIEWER_` → `LLM_REVIEWER_` (env vars — do first, most specific)
2. `copilot-reviewer` → `llm-reviewer` (package name, MCP name)
3. `copilot-review` → `llm-review` (CLI binary name — careful: don't replace `copilot-reviewer`)
4. `Copilot Code Review` → `LLM Code Review` (formatter header)
5. `.copilot-review` → `.llm-reviewer` (dogfood config dir in repo)
6. `.code-reviewer` → `.llm-reviewer` (config dir paths)
7. `copilot_review` → `llm_review`, `copilot_chat` → `llm_chat`, `copilot_models` → `llm_models` (MCP tool names)
8. Version `0.1.0` → `1.0.0` (in package.json, cli.ts VERSION constant, mcp-server.ts)

**Ordering matters:** replace `copilot-reviewer` before `copilot-review` to avoid partial matches.

## Testing

After rename:
1. `npx vitest run` — all 500 tests pass
2. `npx tsc --noEmit` — clean
3. `npm run build` — clean
4. `node dist/cli.js --help` — shows "llm-review" and "LLMs"
5. `node dist/cli.js status` — works with new config paths
6. `node dist/cli.js models --provider ollama` — still works
