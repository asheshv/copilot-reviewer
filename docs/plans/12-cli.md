# Task 12: CLI Entry Point

[Back to Plan Index](./README.md) | Prev: [11 — Exports](./11-exports.md) | Next: [13 — MCP Server](./13-mcp-server.md)

**Dependencies:** Task 11 (exports)
**Spec ref:** [08 — CLI](../spec/08-cli.md)

**Files:**
- Create: `src/cli.ts`
- Test: `test/cli.test.ts`

---

- [ ] **Step 1: Write failing tests**

Spawn the built CLI binary via child process. Mock the Copilot API via msw in test setup.

```typescript
describe("CLI", () => {
  describe("argument parsing", () => {
    it("no args defaults to local mode");
    it("accepts all 7 modes as positional arguments");
    it("parses --model flag");
    it("parses --format flag");
    it("parses --stream and --no-stream flags");
    it("parses --prompt flag");
    it("parses --config flag");
    it("parses --verbose flag");
  });

  describe("exit codes", () => {
    it("exits 0 on success with no HIGH findings");
    it("exits 1 when review contains HIGH severity");
    it("exits 2 on auth failure");
    it("exits 3 on diff error (empty, not git repo)");
    it("exits 4 on API error");
    it("exits 5 on config error");
  });

  describe("output", () => {
    it("review content goes to stdout");
    it("progress messages go to stderr");
    it("--format json produces valid JSON on stdout");
    it("--stream --format json produces NDJSON lines");
  });

  describe("TTY detection", () => {
    it("non-TTY stdout defaults to json format");
  });

  describe("subcommands", () => {
    it("models subcommand lists models");
    it("chat subcommand sends message and prints response");
    it("chat uses empty system prompt (not review prompt)");
  });

  describe("--help and --version", () => {
    it("--help shows usage and exits 0");
    it("--version shows version and exits 0");
  });

  describe("--mcp mode", () => {
    it("--mcp starts MCP server (does not crash immediately)");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL.

- [ ] **Step 3: Implement cli.ts**

Add `#!/usr/bin/env node` shebang at top.

Use `commander` for argument parsing:

```typescript
const program = new Command()
  .name("copilot-review")
  .version(VERSION)
  .description("Review code changes using GitHub Copilot");

// --mcp mode: delegate to MCP server and exit
if (process.argv.includes("--mcp")) {
  await import("./mcp-server.js").then(m => m.startServer());
  // never returns
}

// Main review command
program
  .argument("[mode]", "Diff mode", "local")
  .argument("[modeArg]", "Mode argument (base branch, PR number, etc.)")
  .option("--model <id>", "Model to use", "auto")
  .option("--format <fmt>", "Output format: text|markdown|json")
  .option("--stream", "Force streaming")
  .option("--no-stream", "Force buffered")
  .option("--prompt <text>", "Override review prompt")
  .option("--config <path>", "Override config file path")
  .option("--verbose", "Enable debug logging")
  .action(handleReview);

// Subcommands
program.command("models").description("List available models").action(handleModels);
program.command("chat <message>").description("Chat with Copilot").action(handleChat);

program.parse();
```

Handler functions:
- `handleReview()`: load config → create auth/client/models → call `review()` or `reviewStream()` → output to stdout → map errors to exit codes
- `handleModels()`: list models → print table to stdout
- `handleChat(message)`: create client → `client.chat()` with empty systemPrompt → print response

TTY detection: `process.stdout.isTTY` — if false, default format to `json`

Stderr progress: `process.stderr.write("Authenticating... ")` etc.

Error → exit code mapping per spec:
- `AuthError` → 2
- `DiffError` → 3
- `ClientError` / `ModelError` → 4
- `ConfigError` → 5
- `detectHighSeverity(content)` → 1
- Success → 0

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: All CLI tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/cli.test.ts
git commit -m "feat: CLI with all modes, flags, subcommands, and MCP mode"
```
