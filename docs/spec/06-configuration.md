# 06 — Configuration

[Back to Spec Index](./README.md) | Prev: [05 — Model Management](./05-model-management.md) | Next: [07 — Review Orchestration](./07-review-orchestration.md)

> See also: [ADR-003 — Config Layering](../adr/003-config-layering.md)

---

## Four-Layer Precedence

```mermaid
graph LR
    A["Layer 1<br/><b>Built-in default</b><br/>(lowest)"] --> B["Layer 2<br/><b>~/.copilot-review/</b><br/>Global config"]
    B --> C["Layer 3<br/><b>&lt;project&gt;/.copilot-review/</b><br/>Project config"]
    C --> D["Layer 4<br/><b>CLI flags</b><br/>(highest)"]
```

| Layer | Source | Scope |
|-------|--------|-------|
| 1 | `prompts/default-review.md` + hardcoded defaults | Ships with the tool |
| 2 | `~/.copilot-review/config.json` + `config.md` | Personal defaults across all projects |
| 3 | `<git-root>/.copilot-review/config.json` + `config.md` | Project team settings (committed to git) |
| 4 | `--model`, `--format`, `--prompt` flags | One-shot invocation override |

## Config JSON Schema

Shared by global (layer 2) and project (layer 3):

```typescript
interface ConfigFile {
  model?: string;              // model ID or "auto"
  format?: "text" | "markdown" | "json";
  stream?: boolean;
  mode?: "extend" | "replace"; // prompt merge strategy (default: "extend")
  prompt?: string;             // inline text OR relative path to .md file
  defaultBase?: string;        // default base branch (e.g. "main")
  ignorePaths?: string[];      // glob patterns to exclude from diff
}
```

## Resolved Config (output)

After merging all layers, every field is resolved (no optionals):

```typescript
interface ResolvedConfig {
  model: string;
  format: "text" | "markdown" | "json";
  stream: boolean;
  prompt: string;              // final assembled prompt text
  defaultBase: string;
  ignorePaths: string[];
}
```

### Built-in Defaults

```json
{
  "model": "auto",
  "format": "markdown",
  "stream": true,
  "mode": "extend",
  "defaultBase": "main",
  "ignorePaths": []
}
```

## Merge Algorithm

### Structured Settings

`model`, `format`, `stream`, `defaultBase`, `ignorePaths` — higher layer simply replaces lower. No merging semantics.

### Prompt (the Review Instructions)

The prompt is the only field with merge semantics, controlled by the `mode` field:

| Mode | Behavior |
|------|----------|
| `"extend"` (default) | Layer's prompt is **appended** to the accumulated prompt from lower layers |
| `"replace"` | Layer's prompt **replaces** everything below it. Higher layers can still extend on top. |
| CLI `--prompt` | Implicit replace — flag value becomes the entire prompt. |

**Concatenation order (when all layers use "extend"):**

```
Built-in default prompt (prompts/default-review.md)

## Additional Instructions (Global)
<global config.md or config.json prompt>

## Project Instructions
<project config.md or config.json prompt>
```

**Example with replace:**

If project config sets `"mode": "replace"`:
```
<project prompt only>
```

If project uses `"replace"` but a CLI `--prompt` is also provided:
```
<CLI prompt only>   (CLI --prompt is always implicit replace)
```

## Prompt Resolution Within a Layer

Each layer has two possible prompt sources:

1. `config.json` → `prompt` field (inline text OR relative path to a `.md` file)
2. `config.md` (standalone file)

Resolution:
- If `config.json` exists and has a `prompt` field → use it (resolve path if relative)
- Else if `config.md` exists → use its contents
- Else → layer contributes no prompt

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Config directory not found | Skip silently (not an error) |
| `config.json` malformed | `ConfigError` with file path and parse details |
| `config.json` exists, `config.md` doesn't | Use `config.json` prompt field (if present) |
| `config.md` exists, `config.json` doesn't | Use `config.md` as prompt; all other settings from lower layers |
| Both missing at a layer | Layer contributes nothing |
| Git root detection fails | Skip project layer |
| `prompt` field is a path that doesn't exist | `ConfigError { code: "prompt_not_found" }` |

## Public API

```typescript
loadConfig(cliOverrides?: CLIOverrides): ResolvedConfig
```

See [10 — Error Handling](./10-error-handling.md) for `ConfigError` types.
