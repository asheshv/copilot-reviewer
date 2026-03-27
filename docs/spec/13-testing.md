# 13 — Testing

[Back to Spec Index](./README.md) | Prev: [12 — Default Prompt](./12-default-prompt.md) | Next: [14 — Future Enhancements](./14-future.md)

---

## Framework

**vitest** — native TypeScript, fast, ESM-first. No transform config headaches.

## Test Structure

Mirrors `src/`:

```
test/
├── lib/
│   ├── auth.test.ts
│   ├── client.test.ts
│   ├── diff.test.ts
│   ├── models.test.ts
│   ├── review.test.ts
│   ├── config.test.ts
│   ├── prompt.test.ts
│   ├── formatter.test.ts
│   └── streaming.test.ts
├── cli.test.ts
├── mcp-server.test.ts
├── fixtures/
│   ├── diffs/                  # sample diff outputs
│   ├── configs/                # sample config.json / config.md files
│   └── responses/              # recorded Copilot API responses
└── e2e/
    └── live-review.test.ts     # manual, needs real token
```

## Test Categories

### Unit Tests (fast, no network, no git)

| File | Key scenarios |
|------|---------------|
| `auth.test.ts` | Token resolution priority (env > config > gh). Each source failing falls to next. All failing produces AuthError. Session token caching and expiry logic. |
| `client.test.ts` | Endpoint routing (responses vs chat completions). o1 model handling. Required headers present. Retry logic (429, 502/503/504, timeouts, secondary 403). Non-retryable error propagation. 401 with authorize_url. Null-safe response parsing (invalid_response error on unexpected shapes). Both `finish_reason` and `done_reason` field handling. Non-streaming parsing for both API formats. Responses API status check (completed vs failed). Chat with empty systemPrompt. |
| `streaming.test.ts` | Chat completions SSE parsing (content, reasoning with both field names). Responses API event parsing (delta as string and as object). Stream termination (DONE marker, finish_reason, done_reason). Abnormal finish_reason values produce error. Stream without DONE marker produces stream_interrupted error. Interrupted stream error. Malformed SSE lines handled gracefully. |
| `diff.test.ts` | Mode to git command mapping (all 7 modes). DiffResult parsing. Binary file detection. Renamed file handling. Empty diff error. Not-a-git-repo error. Git-not-installed error. Invalid ref error (range mode). Shallow clone insufficient_history error. No-commits error. ignorePaths filtering. Diff size limit enforcement. |
| `config.test.ts` | Layer precedence (built-in, global, project, CLI). Extend mode concatenation order. Replace mode discards lower layers. Standalone .md without .json. Missing config silent skip. Malformed config produces ConfigError. ignorePaths union merge across layers. CLIOverrides applied correctly. Prompt file path vs inline text heuristic. Path normalization on Windows (forward slashes). ~ expansion via os.homedir(). |
| `formatter.test.ts` | Markdown: header, content passthrough, footer. Text: markdown stripped. JSON: valid JSON, all fields present, exitCode. NDJSON streaming format. Warnings in each format. exitCode severity detection (regex for HIGH patterns). Empty response handling. |
| `models.test.ts` | Model list parsing and filtering. Deduplication (highest version wins). Auto selection. Model validation (ID exists). Policy auto-enable. |
| `prompt.test.ts` | Default prompt loads from prompts/default-review.md. User message assembly (summary + diff). |

### Integration Tests (requires git, no network)

| File | Key scenarios |
|------|---------------|
| `cli.test.ts` | Argument parsing (all modes, all flags). Exit codes (0-5 mapping). stdout/stderr separation. TTY detection and format default. Help and version output. Subcommands (`models`, `chat`) execute and return valid output. `--mcp` flag starts MCP server mode. Default mode (no args) runs `local`. `--stream --format json` produces NDJSON. |
| `mcp-server.test.ts` | Tool registration (3 tools exposed). Tool parameter validation (invalid mode, missing required params for pr/range/commits modes). Structured error responses (isError: true). Server stays alive after errors. Tool-to-ReviewOptions mapping correctness. |

CLI tests spawn the CLI binary and mock the Copilot API via fixtures. MCP tests use the MCP SDK test client.

### E2E Tests (requires network + auth, manual)

```
test/e2e/live-review.test.ts
```

- Real Copilot API call with a small fixture diff.
- Validates the full pipeline: auth, model selection, review, formatting.
- **Skipped in CI** — needs a real token and burns Copilot quota.
- Run manually: `GITHUB_TOKEN=... vitest e2e/`

## Mocking Strategy

| Boundary | Tool | Why |
|----------|------|-----|
| HTTP (Copilot API) | msw (Mock Service Worker) | Intercepts at network level — client code tested as written |
| Git commands | Mock child process calls | Avoid needing real git repos in unit tests |
| File system (config) | Temp directories | Real FS operations, isolated per test |
| Between lib/ modules | **No mocking** | Test through public API boundaries |

### Why msw Over Mocking fetch

msw intercepts at the HTTP level. The client code uses real `fetch` — no patching, no dependency injection for testing purposes. This catches issues like missing headers, wrong URLs, and serialization bugs that mock-based approaches miss.

### Why No Mocking Between Modules

If `review.ts` calls `diff.ts`, the test for `review.ts` uses the real `diff.ts` (with git mocked at the process boundary). This tests actual integration between modules, not just contracts.

## Recorded Fixtures

`test/fixtures/responses/` contains captured real Copilot API responses in both formats:
- Chat Completions (streaming + non-streaming)
- Responses API (streaming + non-streaming)

These serve as regression anchors. The Copilot API is undocumented — when it changes, fixture diffs show exactly what shifted.

## Test Development Approach

TDD — tests are written before implementation.
