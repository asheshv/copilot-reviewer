# Multi-Provider Support & Chunked Review — Implementation Summary

**Date:** 2026-03-31
**Commits:** 39 (df99534..d731320)
**Scope:** 36 files changed, +9,919 / -2,790 lines
**Tests:** 500 passing (was 330 before), 88.6% statement coverage
**Spec:** `docs/spec/15-multi-provider-and-chunked-review.md`

---

## What Was Built

### 1. Provider Abstraction (Phase 1)

Replaced the hardcoded `CopilotClient` + `ModelManager` with a pluggable `ReviewProvider` interface.

**Architecture:**

```
ReviewProvider (interface)
  └── OpenAIChatProvider (abstract base — shared /chat/completions protocol)
        ├── CopilotProvider (GitHub Copilot API + Responses API routing)
        └── OllamaProvider (local Ollama LLMs)
```

**Key files:**
- `src/lib/providers/types.ts` — `ReviewProvider` interface (10 methods: initialize, chat, chatStream, listModels, validateModel, autoSelect, dispose, healthCheck)
- `src/lib/providers/openai-chat-provider.ts` — shared HTTP client, retry logic, SSE streaming, error handling
- `src/lib/providers/copilot-provider.ts` — Copilot auth, Responses API routing with per-model fallback, model discovery/dedup/policy
- `src/lib/providers/ollama-provider.ts` — no-auth, `/api/tags` + `/api/show` model discovery, context length extraction, URL validation
- `src/lib/providers/index.ts` — registry-based factory (`createProvider()`, `availableProviders()`)

**What was deleted:** `client.ts` and `models.ts` — all logic absorbed into the provider classes.

### 2. Status Command (Phase 2)

New subcommand: `copilot-review status`

Shows resolved configuration, provider health, auth state, and available models in one view. Supports `--json` for machine-readable output with full `StatusOutput` schema.

```
$ copilot-review status --provider ollama
  Provider:         ollama
  Model:            auto
  API reachable:    ✓ (4ms)
  Models:           qwen2.5-coder:32b, qwen2.5-coder:14b
```

### 3. Chunked Review — Map-Reduce Pipeline (Phase 3)

Automatically splits large diffs that exceed model context limits into chunks, reviews each independently, then aggregates findings via a reduce pass.

**How it works:**

```
Diff → splitDiffByFile() → binPackFiles(FFD) → MAP (sequential provider.chat per chunk)
  → if 1 chunk: return directly (skip reduce)
  → if N chunks: REDUCE (provider.chat with aggregation prompt) → unified review
```

**Key features:**
- **Auto-chunking:** kicks in at 80% of model context budget (`chunking: "auto"`)
- **File-boundary preservation:** never splits a single file across chunks (unless it exceeds the budget alone — then hunk-level splitting)
- **Severity-aware truncation:** when reduce input exceeds budget, drops LOW first, compresses MEDIUM, preserves HIGH
- **Streaming support:** map phase buffered, reduce phase streamed; progress markers on stderr
- **Budget retry:** on context-length API error, retries the chunk with 0.8x budget
- **Reduce failure fallback:** if aggregation fails, returns raw per-chunk findings labeled "(unaggregated)"
- **Kill switch:** `chunking: "never"` or `CODEREVIEWER_CHUNKING=never` disables entirely

**Key files:**
- `src/lib/chunking.ts` — `splitDiffByFile()`, `binPackFiles()`, `splitFileByHunks()`
- `src/lib/truncation.ts` — `parseSeverityTiers()`, `truncateForReduce()` (4-round cascade)
- `src/lib/prompt.ts` — `assembleChunkMessage()`, `assembleReduceMessage()`, `getReduceSystemPrompt()`, `assembleFileManifest()`
- `src/lib/review.ts` — `shouldChunk()`, `chunkedReview()`, `chunkedReviewStream()`
- `src/lib/formatter.ts` — chunk metadata in output (`Chunks: N`, `chunkedBreakdown`)

### 4. Ollama Provider (Phase 4)

Enables fully local code review using any Ollama model.

```bash
# List available Ollama models
copilot-review models --provider ollama

# Review with a specific model
copilot-review local --provider ollama --model qwen2.5-coder:14b

# With custom Ollama URL
copilot-review local --provider ollama --ollama-url http://remote:11434 --model codellama
```

**Model discovery:** Two-step — `GET /api/tags` for model names, `POST /api/show` per model for context length (falls back to 4096 if unavailable).

### 5. Configuration Enhancements

**New CLI flags:**
- `--provider <name>` — `copilot` or `ollama`
- `--chunking <mode>` — `auto`, `always`, `never`
- `--ollama-url <url>` — Ollama base URL
- `--timeout <seconds>` — request timeout (default: 30s copilot, 120s ollama)

**Environment variables:**
- `CODEREVIEWER_PROVIDER` — provider override
- `CODEREVIEWER_OLLAMA_URL` — Ollama URL override
- `CODEREVIEWER_CHUNKING` — chunking kill switch

**Config paths:** `~/.code-reviewer/config.json` (new) with silent fallback to `~/.copilot-review/` (old). Warning emitted if both exist.

**Config merge order:** Defaults → env vars → global config → project config → CLI (env vars lose to config files — intentional design).

---

## Quality Assurance

### Review Process

3 rounds of aggressive parallel reviews (Logic/Correctness, Security/Config, Chunking/Truncation), fixing all HIGH and MEDIUM findings between rounds.

| Round | HIGH found | MEDIUM found | All fixed |
|-------|-----------|-------------|-----------|
| 1 | 9 | 12 | Yes |
| 2 | 2 | 3 | Yes |
| 3 | 0 | 1 | Yes |

### Notable Bugs Found and Fixed

- **Double-retry nesting:** `CopilotProvider.chat()` wrapped `super.chat()` inside `this.retry()` — caused up to 9 retries instead of 3. Fixed by moving fallback outside retry().
- **Streaming timeout gap:** timeout was cleared after HTTP response, leaving SSE stream phase with no timeout guard. Fixed by clearing only in `finally` block.
- **checkTokenBudget vs shouldChunk ordering:** `reviewStream()` threw `diff_too_large` before chunking could handle the oversized diff. Fixed by checking chunking first.
- **Round 4 HIGH latch:** severity-aware truncation absorbed all post-HIGH content (including MEDIUM/LOW) into the preserved HIGH section. Fixed by resetting on MEDIUM/LOW markers.
- **AuthError string-name check:** `copilot-provider.ts` used `error.name === "AuthError"` instead of `instanceof AuthError`. Fragile — breaks on minification.
- **Commander subcommand option parsing:** `models --provider ollama` was routed to the root review handler because Commander treated `models` as the `[mode]` positional argument. Fixed with `enablePositionalOptions()`.

### Remaining LOW Issues (Won't Fix — Documented)

| # | Issue | Rationale |
|---|-------|-----------|
| L2 | Copilot healthCheck returns 401 post-initialize (no auth headers) | Spec design: healthCheck callable before initialize() |
| L3 | Ollama `_inflight` cleared in finally before rejection propagates | Correct: don't permanently lock on failure |
| L11 | `--mcp` pre-parse wins over subcommands | Pre-existing, intentional design |

---

## Testing Summary

| Category | Count |
|----------|-------|
| Total tests | 500 |
| Statement coverage | 88.6% |
| Branch coverage | 82.0% |
| Function coverage | 97.5% |
| Test files | 18 |

Key coverage areas:
- `formatter.ts`, `auth.ts`, `prompt.ts`, `types.ts`, `index.ts` — 100%
- `truncation.ts` — 96.8%
- `chunking.ts` — 94.4%
- `copilot-provider.ts` — 70.6% (Responses API error paths hard to trigger in unit tests)

### End-to-End Verification

Tested against real Ollama instance with `qwen2.5-coder:14b` and `qwen2.5-coder:32b`:
- `copilot-review models --provider ollama` — lists models with context lengths
- `copilot-review status --provider ollama` — shows health, latency, model list
- `copilot-review commits 1 --provider ollama --model qwen2.5-coder:14b` — full review with chunking (model has 4096 context → auto-chunks)

---

## Future Considerations

### Rename: `copilot-reviewer` → `llm-reviewer`

With multi-provider support, the "copilot" name no longer reflects the tool's scope. `llm-reviewer` maintains the `-reviewer` suffix pattern while accurately describing what the tool does. This is a cosmetic change that can be done separately — involves updating:
- `package.json` name and bin
- Config directory names
- CLI help text and headers
- README and documentation
- npm publish under new name

### Other Future Enhancements (from spec Section 9)

- Independently configurable reduce model
- Runtime plugin loading (file-based or npm-based providers)
- Parallel chunk execution
- Anthropic provider (non-OpenAI protocol)
- File/directory scoped review (`--path`)
- Config migration tooling
