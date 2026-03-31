# 16 — Rename: copilot-reviewer → llm-reviewer

[Back to Spec Index](./README.md) | Previous: [15 — Multi-Provider & Chunked Review](./15-multi-provider-and-chunked-review.md)

---

## Overview

Rename the tool from `copilot-reviewer` to `llm-reviewer` to reflect multi-provider support (Copilot, Ollama, future LLMs). Bump version to `1.0.0`. Rename the GitHub repo. Clean cut — no backward-compat fallbacks.

## Rename Map

| Item | Old | New |
|------|-----|-----|
| Package name (`package.json`) | `copilot-reviewer` | `llm-reviewer` |
| Package description | "Review code changes using GitHub Copilot" | "Review code changes using LLMs" |
| CLI binary (`package.json` bin) | `copilot-review` | `llm-review` |
| Version | `0.1.0` | `1.0.0` |
| GitHub repo | `asheshv/copilot-reviewer` | `asheshv/llm-reviewer` |
| Project title (docs) | "GitHub Copilot Reviewer" | "LLM Reviewer" |
| Config dir (global) | `~/.code-reviewer/` | `~/.llm-reviewer/` |
| Config dir (project) | `.code-reviewer/` | `.llm-reviewer/` |
| Dogfood config (this repo) | `.copilot-review/` | `.llm-reviewer/` |
| Fallback config dirs | Remove entirely | Single path only, no fallback chain |
| Env var: provider | `CODEREVIEWER_PROVIDER` | `LLM_REVIEWER_PROVIDER` |
| Env var: Ollama URL | `CODEREVIEWER_OLLAMA_URL` | `LLM_REVIEWER_OLLAMA_URL` |
| Env var: chunking | `CODEREVIEWER_CHUNKING` | `LLM_REVIEWER_CHUNKING` |
| MCP server name | `copilot-reviewer` | `llm-reviewer` |
| MCP tool names | `copilot_review`, `copilot_chat`, `copilot_models` | `llm_review`, `llm_chat`, `llm_models` |
| MCP tool descriptions | "Review code changes using GitHub Copilot" | "Review code changes using LLMs" |
| CLI description | "Review code changes using GitHub Copilot" | "Review code changes using LLMs" |
| Formatter headers | "Copilot Code Review" | "LLM Code Review" |
| Editor-Version header | `copilot-reviewer/0.1.0` | `llm-reviewer/1.0.0` |
| Editor-Plugin-Version header | `copilot-reviewer/0.1.0` | `llm-reviewer/1.0.0` |
| Debug env check | `DEBUG === "copilot-review"` | `DEBUG === "llm-review"` |
| Entry point detection | `copilot-review` in argv | `llm-review` in argv |
| Chat feature description | "Free-form Copilot chat" | "Free-form LLM chat" |

## What Does NOT Change

- Provider names: `"copilot"`, `"ollama"` — these are provider identifiers, not tool names
- `AuthProvider` interface or auth logic
- Copilot API headers: `Copilot-Integration-Id: vscode-chat`, `x-github-api-version` — API requirements
- Default provider: `"copilot"` (unchanged)
- Any functional behavior, algorithms, or test logic
- Spec filenames that reference the Copilot API (e.g., `04-copilot-client.md`, `docs/reference/copilot-api-reference.md`) — these describe the API, not the tool
- References to "Copilot" when describing the Copilot provider specifically (e.g., `CopilotProvider` class name)

## Files Affected

### Source

| File | Changes |
|------|---------|
| `package.json` | name, version, bin, description |
| `package-lock.json` | regenerated via `npm install` after `package.json` changes |
| `src/cli.ts` | CLI name, description ("Review code changes using LLMs"), `VERSION` constant, debug env, entry point detection, error messages |
| `src/mcp-server.ts` | server name/version (`llm-reviewer/1.0.0`), tool names (`llm_review`, `llm_chat`, `llm_models`), tool descriptions ("Review code changes using LLMs", "Free-form LLM chat") |
| `src/lib/config.ts` | config dir paths (single `~/.llm-reviewer/`, no fallback), env var names (`LLM_REVIEWER_*`), warning messages. **Remove the fallback logic** in `resolveGlobalConfigDir()` and `resolveProjectConfigDir()` — simplify to single-path resolution. |
| `src/lib/formatter.ts` | "Copilot Code Review" → "LLM Code Review" |
| `src/lib/providers/copilot-provider.ts` | `Editor-Version`, `Editor-Plugin-Version` header values |

### Tests

All test files containing hardcoded references to:
- `"copilot-review"` / `"copilot-reviewer"` (CLI/package name)
- `"Copilot Code Review"` / `"LLM Code Review"` (formatter header)
- `CODEREVIEWER_*` (env var names)
- `.code-reviewer/` or `.copilot-review/` (config paths)
- `copilot_review` / `copilot_chat` / `copilot_models` (MCP tool names)
- `"Free-form Copilot chat"` (tool descriptions)
- `"Review code changes using GitHub Copilot"` (tool descriptions)

### Config

Rename directory in this repo:
```
.copilot-review/ → .llm-reviewer/
```

### Docs — full list

All markdown files in `docs/` need updating. Specific high-density files:

| File(s) | Key changes |
|---------|-------------|
| `docs/spec/README.md` | Title "GitHub Copilot Reviewer" → "LLM Reviewer", CLI name, MCP tool names, description |
| `docs/plans/README.md` | Title "GitHub Copilot Reviewer" → "LLM Reviewer" |
| `README.md` | Full update: tool name, CLI examples, config paths, env vars, "Free-form LLM chat" |
| `docs/spec/01-architecture.md` | `.copilot-review/` in project structure tree |
| `docs/spec/06-configuration.md` | `~/.copilot-review/` config paths |
| `docs/spec/07-review-orchestration.md` | `DEBUG=copilot-review` |
| `docs/spec/08-cli.md` | CLI name, "Free-form Copilot chat" |
| `docs/spec/09-mcp-server.md` | Tool names, descriptions |
| `docs/spec/10-error-handling.md` | Config path in error examples |
| `docs/spec/14-future.md` | `copilot-reviewer-action@v1` → `llm-reviewer-action@v1` |
| `docs/spec/15-multi-provider-and-chunked-review.md` | `copilot-review` CLI, `.code-reviewer/`, `CODEREVIEWER_*` throughout |
| `docs/adr/003-config-layering.md` | `~/.copilot-review/`, `copilot-review --prompt` |
| `docs/plans/*.md` | ~50+ references across plan files (old CLI name, config paths, env vars) |
| `docs/scratch/*.md` | Old references in summary docs |

### package-lock.json

Do NOT manually edit. After updating `package.json`, run `npm install` to regenerate.

## Logic Change: Remove Config Fallback Chain

The current `config.ts` has a two-tier fallback:
- `resolveGlobalConfigDir()`: tries `~/.code-reviewer/`, falls back to `~/.copilot-review/`
- `resolveProjectConfigDir()`: tries `<root>/.code-reviewer/`, falls back to `<root>/.copilot-review/`

After rename, these fallbacks are no longer meaningful. **Remove the fallback logic entirely** — replace `resolveGlobalConfigDir()` and `resolveProjectConfigDir()` with simple single-path functions:

```typescript
function getGlobalConfigDir(): string {
  return join(homedir(), ".llm-reviewer");
}

function getProjectConfigDir(gitRoot: string): string {
  return join(gitRoot, ".llm-reviewer");
}
```

Also remove:
- The `dirHasConfig()` helper (no longer needed for fallback probing)
- The "both paths exist" warning logic
- Any `resolveGlobalConfigDir` / `resolveProjectConfigDir` async functions
- Related tests for fallback behavior

This is the **one logic change** — it simplifies the codebase by removing ~40 lines of fallback resolution.

## GitHub Repo Rename

1. Go to GitHub → Settings → rename `copilot-reviewer` → `llm-reviewer`
2. GitHub auto-redirects the old URL
3. Update local git remote:
```bash
git remote set-url origin git@github.com:asheshv/llm-reviewer.git
```

## Implementation Approach

### Replacement Rules (in order)

1. `CODEREVIEWER_` → `LLM_REVIEWER_` (env vars — most specific, do first)
2. `GitHub Copilot Reviewer` → `LLM Reviewer` (project title in docs)
3. `copilot-reviewer` → `llm-reviewer` (package name, MCP name — before rule 4)
4. `copilot-review` → `llm-review` (CLI binary — careful: don't match `copilot-reviewer`)
5. `Copilot Code Review` → `LLM Code Review` (formatter header)
6. `Review code changes using GitHub Copilot` → `Review code changes using LLMs` (descriptions)
7. `Free-form Copilot chat` / `Free-form chat with Copilot` → `Free-form LLM chat` (chat descriptions)
8. `copilot_review` → `llm_review`, `copilot_chat` → `llm_chat`, `copilot_models` → `llm_models` (MCP tools)
9. `.copilot-review` → `.llm-reviewer` (dogfood config dir)
10. `.code-reviewer` → `.llm-reviewer` (config dir paths)
11. `copilot-reviewer-action` → `llm-reviewer-action` (future references in docs)
12. Version `0.1.0` → `1.0.0` (package.json, cli.ts, mcp-server.ts)

**Ordering matters:** rules 2-3 before rule 4 to avoid partial matches.

**After replacement:** manually review each file for remaining "Copilot" references that should stay (provider name, API references) vs. should change (tool name).

### Steps

1. Remove fallback logic in `config.ts` (the one logic change)
2. Apply replacement rules 1-12 across source files
3. Apply replacement rules across test files
4. Rename `.copilot-review/` directory to `.llm-reviewer/`
5. Apply replacement rules across all `docs/` markdown files
6. Update `README.md`
7. Run `npm install` to regenerate `package-lock.json`
8. Run full verification (see Testing below)
9. Commit as single commit
10. GitHub repo rename (manual)
11. `git remote set-url origin git@github.com:asheshv/llm-reviewer.git`

## Testing

After rename:
1. `npx vitest run` — all tests pass
2. `npx tsc --noEmit` — clean
3. `npm run build` — clean
4. `node dist/cli.js --help` — shows "llm-review" and "Review code changes using LLMs"
5. `node dist/cli.js status` — works with `~/.llm-reviewer/` paths
6. `node dist/cli.js status --provider ollama` — Ollama still works
7. `node dist/cli.js models --provider ollama` — lists models
8. Grep verification: `grep -r "copilot-review\|CODEREVIEWER_\|\.code-reviewer\|Copilot Code Review" src/ test/ --include="*.ts"` returns NO results (only provider-level "Copilot" references remain)
