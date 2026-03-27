# Task 08: Configuration + Prompt

[Back to Plan Index](./README.md) | Prev: [07 — Diff](./07-diff.md) | Next: [09 — Formatter](./09-formatter.md)

**Dependencies:** Task 2 (types)
**Spec ref:** [06 — Configuration](../spec/06-configuration.md), [12 — Default Prompt](../spec/12-default-prompt.md), [07 — Review Orchestration](../spec/07-review-orchestration.md) — prompt.ts section

**Files:**
- Create: `src/lib/config.ts`, `src/lib/prompt.ts`, `prompts/default-review.md`
- Test: `test/lib/config.test.ts`, `test/lib/prompt.test.ts`
- Create: `test/fixtures/configs/` (sample config files)

---

- [ ] **Step 1: Create prompts/default-review.md**

Read [spec 12 — Default Prompt](../spec/12-default-prompt.md) and write the full prompt. Key elements:
- Role: "You are an expert code reviewer"
- Priority order: Security > Correctness > Performance > Readability > Simplicity (with detailed bullet points per category from spec 12)
- Output format per finding: `### HIGH <title>` (one severity per header, NOT `[HIGH|MEDIUM|LOW]`)
- File/line reference: `**File:** \`path\` **Line:** N`
- Category label per finding
- Suggestion with code block
- Rules: flag security as HIGH even if unlikely, scrutinize every code path, don't invent findings, end with severity summary

- [ ] **Step 2: Create test config fixtures**

Create `test/fixtures/configs/`:
- `global/config.json` — `{ "model": "gpt-4.1", "mode": "extend", "ignorePaths": ["*.lock"] }`
- `global/config.md` — "Also check for PL/pgSQL patterns."
- `project/config.json` — `{ "mode": "replace", "defaultBase": "develop" }`
- `project/config.md` — "Focus on React component patterns."
- `project-extend/config.json` — `{ "mode": "extend", "ignorePaths": ["vendor/**"] }`
- `malformed/config.json` — `{ invalid json }`
- `empty/config.md` — (0 bytes)
- `path-prompt/config.json` — `{ "prompt": "custom.md" }`
- `path-prompt/custom.md` — "Custom prompt content."

- [ ] **Step 3: Write failing tests for prompt.ts**

```typescript
describe("loadBuiltInPrompt", () => {
  it("reads prompts/default-review.md and returns content");
  it("content includes Security priority keywords");
  it("content includes severity format (### HIGH)");
});

describe("assembleUserMessage", () => {
  it("includes summary with file count and stats");
  it("includes raw diff in code block");
  it("formats correctly for single-file diff");
  it("formats correctly for multi-file diff");
});
```

- [ ] **Step 4: Write failing tests for config.ts**

```typescript
describe("loadConfig", () => {
  describe("layer precedence", () => {
    it("built-in defaults used when no config exists");
    it("global config overrides built-in");
    it("project config overrides global");
    it("CLI overrides override project");
  });

  describe("prompt merge - extend mode", () => {
    it("concatenates built-in + global + project prompts with section headers");
    it("built-in prompt always present in extend mode");
  });

  describe("prompt merge - replace mode", () => {
    it("project replace discards built-in and global");
    it("CLI --prompt replaces everything (implicit replace)");
    it("multiple replace layers: highest wins");
  });

  describe("ignorePaths", () => {
    it("union across all layers (not replace)");
    it("deduplicates entries");
  });

  describe("structured settings", () => {
    it("model: last-layer-wins");
    it("format: last-layer-wins");
    it("stream: last-layer-wins");
    it("defaultBase: last-layer-wins");
  });

  describe("prompt resolution within a layer", () => {
    it("config.json prompt field used when present");
    it("falls back to config.md when no prompt field in json");
    it("prompt ending in .md resolved as file path when file exists");
    it("prompt not ending in .md treated as inline text");
    it("prompt path not found throws ConfigError prompt_not_found");
    it("empty config.md treated as no prompt contribution");
  });

  describe("CLIOverrides", () => {
    it("--config replaces project layer only");
    it("--model overrides model");
    it("--format overrides format");
    it("--stream overrides stream");
  });

  describe("edge cases", () => {
    it("missing config directory skipped silently");
    it("malformed config.json throws ConfigError malformed_json");
    it("git root detection failure skips project layer");
  });

  describe("platform", () => {
    it("expands ~ paths via os.homedir()");
    it("normalizes paths to forward slashes");
  });
});
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL.

- [ ] **Step 6: Implement prompt.ts**

Two exports:
- `loadBuiltInPrompt(): string` — reads `prompts/default-review.md` (relative to package root, resolved via `import.meta.url`)
- `assembleUserMessage(diff: DiffResult): string` — formats summary + diff markdown

- [ ] **Step 7: Implement config.ts**

`loadConfig(cliOverrides?: CLIOverrides): ResolvedConfig`:

1. Start with built-in defaults (calls `loadBuiltInPrompt()` for Layer 1 prompt)
2. Load global config from `os.homedir() + "/.copilot-review/"` — read `config.json` + `config.md`
3. Load project config: detect git root by spawning `git rev-parse --show-toplevel`. If command fails (exit code != 0) or stdout is empty → skip project layer silently (allows use outside git repos). If `cliOverrides.config` is provided, use that path instead of git root detection.
4. Apply CLI overrides (Layer 4)
5. Merge structured settings: last-layer-wins for model/format/stream/defaultBase
6. Merge `ignorePaths`: union (concat + deduplicate) across all layers
7. Merge prompt: based on `mode` field — extend appends with section headers, replace discards below

Helper: `loadLayerConfig(dirPath)` — reads config.json (if exists) + config.md (if exists), resolves prompt field (file path heuristic: ends with `.md` + exists → file, else → inline text)

- [ ] **Step 8: Run tests to verify they pass**

Run: `npm test`
Expected: All config and prompt tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/lib/config.ts src/lib/prompt.ts prompts/default-review.md test/lib/config.test.ts test/lib/prompt.test.ts test/fixtures/configs/
git commit -m "feat: config loading with 4-layer merge and default review prompt"
```
