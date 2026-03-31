# Rename copilot-reviewer → llm-reviewer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the tool from `copilot-reviewer` to `llm-reviewer`, bump to v1.0.0, remove config fallback chain.

**Architecture:** Pure find-and-replace across source, tests, config, and docs. One logic change: remove the two-tier config fallback chain in `config.ts` and `cli.ts`, replacing with single-path `~/.llm-reviewer/` resolution. 18 ordered replacement rules applied longest-first to avoid partial match corruption.

**Tech Stack:** TypeScript, Node.js, vitest

**Spec:** `docs/spec/16-rename-llm-reviewer.md`

---

## Task 1: Remove Config Fallback Logic

The only logic change. Remove the two-tier fallback (`~/.code-reviewer/` → `~/.copilot-review/`) and replace with single-path resolution to `~/.llm-reviewer/`.

**Files:**
- Modify: `src/lib/config.ts`
- Modify: `src/cli.ts`
- Modify: `src/lib/types.ts`
- Modify: `test/lib/config.test.ts`
- Modify: `test/cli.test.ts`

- [ ] **Step 1: Read current fallback logic**

Read `src/lib/config.ts` (functions `resolveGlobalConfigDir`, `resolveProjectConfigDir`, `dirHasConfig`) and `src/cli.ts` (function `resolveConfigStatus`). Understand the fallback chain before removing it.

- [ ] **Step 2: Simplify config.ts — replace resolveGlobalConfigDir/resolveProjectConfigDir**

Replace the async fallback-probing functions with simple path helpers:

```typescript
// Replace resolveGlobalConfigDir() and resolveProjectConfigDir() with:
function getGlobalConfigDir(): string {
  return join(homedir(), ".llm-reviewer");
}

function getProjectConfigDir(gitRoot: string): string {
  return join(gitRoot, ".llm-reviewer");
}
```

Remove:
- `resolveGlobalConfigDir()` async function
- `resolveProjectConfigDir()` async function
- `dirHasConfig()` helper
- The "both paths exist" warning logic
- Any references to `.code-reviewer` or `.copilot-review` in path construction

Update `loadConfig()` to use the new synchronous helpers instead of the async resolve functions.

- [ ] **Step 3: Simplify cli.ts — replace resolveConfigStatus fallback probing**

In `resolveConfigStatus()` (or equivalent in `handleStatus`), remove:
- Old path probing for `.code-reviewer/` and `.copilot-review/`
- `fallback` and `fallbackFound` properties in the status output
- The warning about both paths existing

Replace with simple single-path existence check for `~/.llm-reviewer/` and `<gitRoot>/.llm-reviewer/`.

- [ ] **Step 4: Update StatusOutput type in types.ts**

Remove `fallback?: string` and `fallbackFound?: boolean` from the `StatusOutput.config.global` and `StatusOutput.config.project` type definitions. These are no longer needed.

- [ ] **Step 5: Update config tests — remove fallback tests, add single-path tests**

In `test/lib/config.test.ts`:
- Remove tests for: "prefers ~/.code-reviewer/ over ~/.copilot-review/", "falls back silently", "emits warning when both exist"
- Update remaining config path tests to use `~/.llm-reviewer/`
- Add test: config loaded from `~/.llm-reviewer/config.json`

- [ ] **Step 6: Update cli tests — remove fallback status tests**

In `test/cli.test.ts`:
- Remove tests that check `fallback`/`fallbackFound` in status output
- Update remaining status tests to expect `~/.llm-reviewer/` paths

- [ ] **Step 7: Run tests and verify**

Run: `npx vitest run`
Expected: tests that reference old paths will fail (expected — they get fixed in Task 2)

Run: `npx tsc --noEmit`
Expected: clean (type changes are consistent)

- [ ] **Step 8: Commit**

```bash
git add src/lib/config.ts src/cli.ts src/lib/types.ts test/lib/config.test.ts test/cli.test.ts
git commit -m "refactor: remove config fallback chain, single-path ~/.llm-reviewer/"
```

---

## Task 2: Apply Replacement Rules to Source Files

Apply all 18 replacement rules to source TypeScript files. Order matters — apply longest/most-specific patterns first.

**Files:**
- Modify: `package.json`
- Modify: `src/cli.ts`
- Modify: `src/mcp-server.ts`
- Modify: `src/lib/config.ts`
- Modify: `src/lib/types.ts`
- Modify: `src/lib/formatter.ts`
- Modify: `src/lib/review.ts`
- Modify: `src/lib/diff.ts`
- Modify: `src/lib/providers/copilot-provider.ts`
- Modify: `src/lib/index.ts`

- [ ] **Step 1: Update package.json**

```json
{
  "name": "llm-reviewer",
  "version": "1.0.0",
  "description": "Review code changes using LLMs",
  "bin": {
    "llm-reviewer": "dist/cli.js"
  }
}
```

- [ ] **Step 2: Apply rules to src/lib/types.ts**

- `CopilotReviewError` → `LlmReviewError` (class name, all `extends` references, `.name` string)
- JSDoc: `"copilot-reviewer errors"` → `"llm-reviewer errors"`

- [ ] **Step 3: Apply rules to src/lib/config.ts**

- `CODEREVIEWER_PROVIDER` → `LLM_REVIEWER_PROVIDER`
- `CODEREVIEWER_OLLAMA_URL` → `LLM_REVIEWER_OLLAMA_URL`
- `CODEREVIEWER_CHUNKING` → `LLM_REVIEWER_CHUNKING`
- `.code-reviewer` → `.llm-reviewer` (any remaining path references)
- `.copilot-review` → `.llm-reviewer` (any remaining references)
- `copilot-review` → `llm-reviewer` (in warning messages, comments)

- [ ] **Step 4: Apply rules to src/lib/diff.ts**

- `COPILOT_REVIEW_MAX_DIFF_SIZE` → `LLM_REVIEWER_MAX_DIFF_SIZE`

- [ ] **Step 5: Apply rules to src/lib/formatter.ts**

- `Copilot Code Review` → `LLM Code Review`

- [ ] **Step 6: Apply rules to src/lib/review.ts**

- `Copilot returned no findings.` → `Provider returned no findings.`

- [ ] **Step 7: Apply rules to src/cli.ts**

- `VERSION = "0.1.0"` → `VERSION = "1.0.0"`
- `copilot-review` → `llm-reviewer` (CLI name, entry point detection, debug env)
- `"Review code changes using GitHub Copilot"` → `"Review code changes using LLMs"`
- `"Chat with Copilot"` → `"Chat with LLM"`
- `CopilotReviewError` → `LlmReviewError` (if imported)

- [ ] **Step 8: Apply rules to src/mcp-server.ts**

- `"copilot-reviewer", version: "0.1.0"` → `"llm-reviewer", version: "1.0.0"`
- `copilot_review` → `llm_review`, `copilot_chat` → `llm_chat`, `copilot_models` → `llm_models`
- `"Review code changes using GitHub Copilot"` → `"Review code changes using LLMs"`
- `"Chat with GitHub Copilot about code"` → `"Chat with LLM about code"`
- `"List available GitHub Copilot models"` → `"List available LLM models"`
- `CopilotReviewError` → `LlmReviewError`

- [ ] **Step 9: Apply rules to src/lib/providers/copilot-provider.ts**

- `"copilot-reviewer/0.1.0"` → `"llm-reviewer/1.0.0"` (Editor-Version, Editor-Plugin-Version headers)

- [ ] **Step 10: Apply rules to src/lib/index.ts**

- `CopilotReviewError` → `LlmReviewError` (if re-exported by name)

- [ ] **Step 11: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 12: Commit**

```bash
git add package.json src/
git commit -m "rename: copilot-reviewer → llm-reviewer across all source files (v1.0.0)"
```

---

## Task 3: Apply Replacement Rules to Test Files

**Files:**
- Modify: `test/lib/types.test.ts`
- Modify: `test/lib/config.test.ts`
- Modify: `test/lib/formatter.test.ts`
- Modify: `test/lib/review.test.ts`
- Modify: `test/lib/diff.test.ts`
- Modify: `test/lib/exports.test.ts`
- Modify: `test/mcp-server.test.ts`
- Modify: `test/cli.test.ts`
- Modify: `test/lib/providers/copilot-provider.test.ts`

- [ ] **Step 1: Apply rules to test/lib/types.test.ts**

- `CopilotReviewError` → `LlmReviewError`
- `".copilot-review/config.json"` → `".llm-reviewer/config.json"` (test data)

- [ ] **Step 2: Apply rules to test/lib/config.test.ts**

- `CODEREVIEWER_*` → `LLM_REVIEWER_*`
- `.code-reviewer` → `.llm-reviewer`
- `.copilot-review` → `.llm-reviewer` (any remaining)
- Remove fallback-specific test data/mocks that reference old paths

- [ ] **Step 3: Apply rules to test/lib/formatter.test.ts**

- `"Copilot Code Review"` → `"LLM Code Review"`
- `"passes through Copilot content as-is"` → `"passes through LLM content as-is"` (test description)

- [ ] **Step 4: Apply rules to test/lib/review.test.ts**

- `"Copilot returned no findings."` → `"Provider returned no findings."`

- [ ] **Step 5: Apply rules to test/lib/diff.test.ts**

- `COPILOT_REVIEW_MAX_DIFF_SIZE` → `LLM_REVIEWER_MAX_DIFF_SIZE`

- [ ] **Step 6: Apply rules to test/lib/exports.test.ts**

- `CopilotReviewError` → `LlmReviewError`

- [ ] **Step 7: Apply rules to test/mcp-server.test.ts**

- `CopilotReviewError` → `LlmReviewError`
- `copilot_review` → `llm_review`, `copilot_chat` → `llm_chat`, `copilot_models` → `llm_models`

- [ ] **Step 8: Apply rules to test/cli.test.ts**

- `copilot-review` → `llm-reviewer` (CLI name assertions)
- `DEBUG=copilot-review` → `DEBUG=llm-reviewer`

- [ ] **Step 9: Apply rules to test/lib/providers/copilot-provider.test.ts**

- `"copilot-reviewer/0.1.0"` → `"llm-reviewer/1.0.0"` (header assertions)

- [ ] **Step 10: Run full test suite**

Run: `npx vitest run`
Expected: ALL 500 tests pass

- [ ] **Step 11: Commit**

```bash
git add test/
git commit -m "rename: update all test files for llm-reviewer"
```

---

## Task 4: Rename Config Directory + Update Docs

**Files:**
- Rename: `.copilot-review/` → `.llm-reviewer/`
- Modify: `README.md`
- Modify: All `docs/**/*.md` files

- [ ] **Step 1: Rename dogfood config directory**

```bash
git mv .copilot-review .llm-reviewer
```

- [ ] **Step 2: Update README.md**

Apply all replacement rules. Key changes:
- Tool name, CLI examples, config paths, env var names
- `"Free-form Copilot chat"` → `"Free-form LLM chat"`
- `copilot-review` → `llm-reviewer` in all CLI examples
- `CODEREVIEWER_*` → `LLM_REVIEWER_*`
- `~/.code-reviewer/` → `~/.llm-reviewer/`

- [ ] **Step 3: Update docs/spec/README.md**

- `"GitHub Copilot Reviewer"` → `"LLM Reviewer"` (title)
- `copilot-review` → `llm-reviewer` (CLI name)
- `copilot_review` / `copilot_chat` / `copilot_models` → `llm_review` / `llm_chat` / `llm_models`

- [ ] **Step 4: Update all other docs/spec/*.md files**

Apply replacement rules to: `01-architecture.md`, `03-diff-collection.md`, `05-model-management.md`, `06-configuration.md`, `07-review-orchestration.md`, `08-cli.md`, `09-mcp-server.md`, `10-error-handling.md`, `11-formatter.md`, `14-future.md`, `15-multi-provider-and-chunked-review.md`, `16-rename-llm-reviewer.md`

Key patterns:
- `copilot-review` → `llm-reviewer`
- `copilot-reviewer` → `llm-reviewer`
- `.copilot-review/` → `.llm-reviewer/`
- `.code-reviewer/` → `.llm-reviewer/`
- `CODEREVIEWER_*` → `LLM_REVIEWER_*`
- `COPILOT_REVIEW_MAX_DIFF_SIZE` → `LLM_REVIEWER_MAX_DIFF_SIZE`
- `GitHub Copilot Reviewer` → `LLM Reviewer`
- `Copilot Code Review` → `LLM Code Review`
- `copilot-reviewer-action` → `llm-reviewer-action`
- `github-copilot-reviewer/` → `llm-reviewer/` (project root in architecture diagrams)

- [ ] **Step 5: Update docs/plans/*.md**

Same replacement rules across all plan files.

- [ ] **Step 6: Update docs/adr/*.md**

- `docs/adr/003-config-layering.md`: `~/.copilot-review/` → `~/.llm-reviewer/`, `copilot-review --prompt` → `llm-reviewer --prompt`

- [ ] **Step 7: Update docs/scratch/*.md**

Same replacement rules.

- [ ] **Step 8: Commit**

```bash
git add .llm-reviewer/ README.md docs/
git rm -r .copilot-review/  # if git mv didn't handle it
git commit -m "rename: config dir + all docs updated for llm-reviewer"
```

---

## Task 5: Regenerate package-lock.json + Final Verification

- [ ] **Step 1: Regenerate package-lock.json**

```bash
npm install
```

This regenerates `package-lock.json` with the new package name and version.

- [ ] **Step 2: Build**

```bash
npm run build
```
Expected: clean TypeScript compilation

- [ ] **Step 3: Run full test suite**

```bash
npx vitest run
```
Expected: ALL tests pass

- [ ] **Step 4: Grep verification — no stale references in source/test**

```bash
grep -rE "copilot-review|copilot_review|copilot_chat|copilot_models|CODEREVIEWER_|COPILOT_REVIEW_|\.code-reviewer|\.copilot-review|Copilot Code Review|Free-form Copilot|CopilotReviewError" src/ test/ --include="*.ts"
```
Expected: NO results

```bash
grep -rni "copilot" src/ test/ --include="*.ts" | grep -v "CopilotProvider\|copilot_internal\|copilot_config\|github-copilot/\|Copilot-Integration-Id\|x-github-api-version\|provider.*copilot\|copilot.*provider"
```
Expected: NO results (only provider-level references remain)

- [ ] **Step 5: Smoke test CLI**

```bash
node dist/cli.js --help
# Should show "llm-reviewer" and "Review code changes using LLMs"

node dist/cli.js status
# Should show ~/.llm-reviewer/ paths

node dist/cli.js models --provider ollama
# Should list Ollama models (if running)
```

- [ ] **Step 6: Commit**

```bash
git add package-lock.json
git commit -m "chore: regenerate package-lock.json for llm-reviewer v1.0.0"
```

- [ ] **Step 7: Push**

```bash
git push origin main
```

- [ ] **Step 8: Rename GitHub repo (manual)**

1. Go to https://github.com/asheshv/copilot-reviewer → Settings → rename to `llm-reviewer`
2. Update local remote:
```bash
git remote set-url origin git@github.com:asheshv/llm-reviewer.git
```

---

## Task Index

| # | Task | Key changes | Dependencies |
|---|------|-------------|--------------|
| 1 | Remove Config Fallback | Simplify config.ts + cli.ts to single-path | None |
| 2 | Rename Source Files | 18 replacement rules across src/ | Task 1 |
| 3 | Rename Test Files | Same rules across test/ | Task 2 |
| 4 | Config Dir + Docs | Rename .copilot-review/, update all docs | Task 2 |
| 5 | Final Verification | package-lock, build, grep, smoke test, push | Tasks 3, 4 |
