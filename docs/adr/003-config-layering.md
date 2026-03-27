# ADR-003: Four-Layer Configuration with Extend/Replace Merge

**Date:** 2026-03-27
**Status:** Accepted

## Context

The tool needs configurable review behavior at multiple scopes: personal defaults, project team standards, and one-off overrides. The review prompt is the most important config — it determines what Copilot looks for and how it reports findings.

## Decision

Four configuration layers with explicit merge control:

```
Layer 1: Built-in default    (prompts/default-review.md + hardcoded settings)
Layer 2: Global config       (~/.copilot-review/config.json + config.md)
Layer 3: Project config      (<git-root>/.copilot-review/config.json + config.md)
Layer 4: CLI flags            (--model, --format, --prompt)
```

Each layer's prompt uses a `mode` field: `"extend"` (default) or `"replace"`.

## Rationale

### Why four layers (not two or three)?

- **Built-in** — safety net. The opinionated security-first prompt should never be silently lost.
- **Global** — personal preferences (preferred model, format) that apply across all projects.
- **Project** — team standards committed to git. New team members get the right config automatically.
- **CLI** — one-shot overrides for experimentation or special cases.

### Why "extend" as default?

The built-in prompt includes security checks (OWASP, injection, auth bypass). If a project sets a custom prompt and the default is "replace", those security checks vanish silently. "Extend" means you add instructions without losing the baseline.

### Why allow "replace" at all?

Some projects need fundamentally different review criteria (e.g., a data pipeline where SQL performance matters more than XSS). Forcing "extend" would mean carrying irrelevant instructions that waste tokens and confuse the model.

### Why .json + .md at each layer?

- `.json` — structured settings (model, format, stream, etc.) that need schema validation.
- `.md` — the review prompt. Markdown is the natural format for prose instructions. Keeping it in a separate file means you can edit the prompt without touching JSON.
- `.md` works standalone without `.json` — lowest friction for teams that just want a custom prompt.

## Alternatives Considered

- **Single config file (YAML/TOML)** — one file per layer with prompt inline. Rejected: prose in YAML is awkward, and it couples structured settings with free-form text.
- **Only extend, never replace** — simpler but too rigid. Some projects genuinely need different prompts.
- **Environment variable overrides** — considered for CI. Deferred: CLI flags cover CI use cases (`copilot-review --prompt "..."` in a pipeline).

## Consequences

- Config loading must find git root for project-level config.
- Missing config at any layer is silent (not an error) — the tool works with zero configuration.
- The prompt concatenation order is fixed: built-in → global → project → CLI. This matches `.gitconfig` semantics (system → global → local).
