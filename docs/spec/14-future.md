# 14 — Future Enhancements

[Back to Spec Index](./README.md) | Prev: [13 — Testing](./13-testing.md)

---

## Documented But Not Built in v1

These items are intentionally deferred. They are recorded here so the design accounts for them (no architectural decisions that would block them) but they are not part of the initial implementation scope.

### Authentication

- **Device flow authentication** — interactive OAuth for users without `gh` CLI or Copilot config. See [02 — Authentication](./02-authentication.md) for protocol details.
- **Persistent token caching** — cache session tokens to disk to avoid exchange on every CLI invocation.

### API Capabilities

- **Tool calling loop** — implement the multi-round tool calling protocol so Copilot can request additional file reads during review. This would let Copilot follow imports, read referenced functions, etc. See [Copilot API Reference](../reference/copilot-api-reference.md) for the tool calling protocol.
- **GitHub Models provider** — alternative API endpoint (`models.github.ai`) with simpler auth but fewer features. See [Copilot API Reference](../reference/copilot-api-reference.md).

### CLI

- **`llm-reviewer quota`** — display remaining premium requests and reset date via `/copilot_internal/user` endpoint.
- **Secret scanning** — pre-scan diff for common secret patterns (API keys, tokens) and warn before sending to Copilot API.

### Review Features

- **BPE tokenizer** — accurate token counting using the model's actual tokenizer vocabulary (e.g., `o200k_base`). Replaces the char/4 heuristic.
- **Severity parsing** — extract structured findings from Copilot's markdown response into typed objects (`{ severity, title, file, line, category, suggestion }`). Enables programmatic filtering and reporting.
- **Watch mode** — re-run review on file changes (`llm-reviewer --watch`).
- **Multi-model review** — run the same diff through multiple models, deduplicate and compare findings.
- **File-level splitting** — for diffs exceeding token limits, automatically split into per-file reviews and aggregate.

### Integration

- **GitHub Actions** — pre-built action for CI pipelines: `uses: owner/llm-reviewer-action@v1`.
- **PR comment posting** — post review findings as GitHub PR comments (inline on specific lines).
- **npm package** — publish to npm for `npx llm-reviewer` usage.

### Configuration

- **JSON schema** — publish a JSON Schema for `config.json` for editor autocomplete and validation.
- **Config validation CLI** — `llm-reviewer config validate` to check config files without running a review.
