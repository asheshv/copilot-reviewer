# GitHub Copilot Reviewer — Design Specification

**Date:** 2026-03-27
**Status:** Draft
**Author:** Ashesh Vashi + Claude

---

## Overview

A TypeScript/Node.js tool that reviews code changes using GitHub Copilot's chat API. Two entry points share a common library:

- **CLI** (`copilot-review`) — standalone command-line tool for reviewing diffs
- **MCP Server** — exposes review, chat, and model listing as tools for any MCP-compatible AI agent

The CLI is the engine; the MCP server is the interface layer. Both import a shared `lib/` — no process spawning between them.

---

## Spec Index

| # | Topic | Description |
|---|-------|-------------|
| [01](./01-architecture.md) | Architecture | Project structure, hybrid design, module boundaries |
| [02](./02-authentication.md) | Authentication | Token resolution, session exchange, future auth plans |
| [03](./03-diff-collection.md) | Diff Collection | 7 diff modes, result shape, validations, edge cases |
| [04](./04-copilot-client.md) | Copilot Client | API endpoint routing, streaming, retry, required headers |
| [05](./05-model-management.md) | Model Management | Listing, auto-selection, caching, validation |
| [06](./06-configuration.md) | Configuration | 4-layer config, merge algorithm, schema, edge cases |
| [07](./07-review-orchestration.md) | Review Orchestration | Pipeline, token budget, message assembly |
| [08](./08-cli.md) | CLI | Usage, exit codes, output behavior, TTY detection |
| [09](./09-mcp-server.md) | MCP Server | Tool definitions, parameters, returns, behaviors |
| [10](./10-error-handling.md) | Error Handling | Error types, codes, exit code mapping, actionable messages |
| [11](./11-formatter.md) | Formatter | Text, markdown, JSON output formats |
| [12](./12-default-prompt.md) | Default Prompt | Review prompt, priorities, output format, rules |
| [13](./13-testing.md) | Testing | Strategy, mocking, fixtures, E2E approach |
| [14](./14-future.md) | Future Enhancements | Documented but not built |

## Related Documents

| Document | Location | Description |
|----------|----------|-------------|
| [Architecture Decisions](../adr/) | `docs/adr/` | ADRs for key design choices |
| [Copilot API Reference](../reference/copilot-api-reference.md) | `docs/reference/` | Reverse-engineered API documentation |
| Architecture Diagrams | Inline in spec files | Mermaid diagrams embedded in relevant spec sections |

## Key Decisions Summary

| Decision | Choice | ADR |
|----------|--------|-----|
| Language | TypeScript (Node.js) | [ADR-001](../adr/001-typescript-over-js.md) |
| Architecture | Hybrid — shared lib, two entry points | [ADR-002](../adr/002-hybrid-architecture.md) |
| Config layering | built-in → global → project → CLI flags | [ADR-003](../adr/003-config-layering.md) |
| Auth sources | `$GITHUB_TOKEN` → Copilot config → `gh` CLI | [02](./02-authentication.md) |
| Diff modes | 7 modes (unstaged, staged, local, branch, PR, commits, range) | [03](./03-diff-collection.md) |
| Model selection | Auto by default, `--model` override | [05](./05-model-management.md) |
| Output formats | text, markdown (default), json | [11](./11-formatter.md) |
| MCP tools | `copilot_review`, `copilot_chat`, `copilot_models` | [09](./09-mcp-server.md) |
| Testing | vitest + msw + recorded fixtures | [13](./13-testing.md) |
| License | MIT | Project root |
