# ADR-002: Hybrid Architecture (Shared Library, Two Entry Points)

**Date:** 2026-03-27
**Status:** Accepted

## Context

The tool needs two interfaces: a standalone CLI for human use and an MCP server for AI agent use. Both perform the same core operations (auth, diff, review).

## Decision

Use a hybrid architecture: shared `lib/` directory with two thin entry points (`cli.ts` and `mcp-server.ts`). Both import the library directly — no process spawning between them.

## Alternatives Considered

### MCP Shells Out to CLI

MCP server spawns the CLI as a child process and parses JSON output.

- **Pro:** True process isolation.
- **Con:** Serialization overhead, awkward streaming, error handling via exit codes.

### Separate Codebases

Two independent projects sharing nothing.

- **Pro:** Complete independence.
- **Con:** Massive duplication, divergent behavior, double maintenance.

## Rationale

- **No serialization overhead** — MCP gets typed return values, not parsed strings.
- **Native streaming** — shared async iterators work across both entry points.
- **Single test suite** — core logic tested once, entry points tested for their thin wrapper behavior.
- **The "independence" of process spawning is artificial** — both are in the same repo, same language. A clean `lib/` API boundary provides the same isolation without the cost.

## Consequences

- `lib/` must have zero dependencies on CLI or MCP concerns.
- Breaking changes in `lib/` affect both entry points simultaneously.
- Both entry points ship in the same npm package.

## Boundary Rules

- `lib/` must not import from `cli.ts`, `mcp-server.ts`, `commander`, `yargs`, or `@modelcontextprotocol/sdk`.
- `lib/` must not reference `process.argv`, `process.stdout`, or terminal-specific APIs.
- `types.ts` is the shared contract — all inter-module types live there.
