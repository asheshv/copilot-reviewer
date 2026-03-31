# Task 15: Final Verification

[Back to Plan Index](./README.md) | Prev: [14 — README](./14-readme.md)

**Dependencies:** All previous tasks

---

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: Clean build, zero errors. All `.ts` files compile to `dist/`.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: All tests pass. Check count matches expected (unit + integration).

- [ ] **Step 3: Type check**

Run: `npm run lint`
Expected: Zero type errors.

- [ ] **Step 4: Verify CLI help**

Run: `node dist/cli.js --help`
Expected: Shows usage with all modes, options, and subcommands.

Run: `node dist/cli.js --version`
Expected: Shows `0.1.0`.

- [ ] **Step 5: Verify MCP server starts**

Run: `echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' | node dist/cli.js --mcp`
Expected: JSON-RPC response with server capabilities (3 tools registered).

- [ ] **Step 6: Manual smoke test (optional — requires real GitHub token)**

> If you don't have a GitHub token, skip this step. Unit tests already cover auth logic with mocks. This step only validates end-to-end flow against the real Copilot API.

```bash
export GITHUB_TOKEN=<your-token>

# List models
node dist/cli.js models

# Review local changes (if any)
node dist/cli.js local

# Chat
node dist/cli.js chat "What does the main function in cli.ts do?"
```

- [ ] **Step 7: Final cleanup commit (if needed)**

If any fixes were needed during verification:
```bash
git add -A
git commit -m "chore: final verification cleanup"
```

---

## Done

At this point you have:
- 12 source modules with full test coverage
- CLI binary (`llm-review`) with 7 diff modes, 3 subcommands
- MCP server with 3 tools (`llm_review`, `llm_chat`, `llm_models`)
- 4-layer configuration with extend/replace prompt merging
- Opinionated default review prompt (Security > Correctness > Performance > Readability > Simplicity)
- 4 output formats (markdown, text, JSON, NDJSON)
- Comprehensive error handling with actionable messages
- MIT license + README documentation
