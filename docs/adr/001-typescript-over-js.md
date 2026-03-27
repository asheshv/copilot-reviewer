# ADR-001: TypeScript Over Plain JavaScript

**Date:** 2026-03-27
**Status:** Accepted

## Context

The project wraps a reverse-engineered, undocumented API (GitHub Copilot chat). The API surface could change at any time without notice.

## Decision

Use TypeScript for the entire codebase.

## Rationale

- **Type definitions as living documentation** — `types.ts` captures the exact shape of every Copilot API request and response. When the API changes, type errors surface the impact immediately.
- **Compile-time safety** — mismatches between the two API formats (Chat Completions vs Responses API) are caught before runtime.
- **IDE support** — autocomplete and inline docs for the complex config merging and streaming interfaces.
- **Trade-off acknowledged** — adds a build step and slightly more project setup compared to plain JS.

## Alternatives Considered

- **Plain JavaScript** — simpler build, no compile step, but loses the type safety that matters most for an undocumented API.

## Consequences

- Requires `tsconfig.json` and a compile step.
- Dev dependencies include `typescript` and `@types/node`.
- All source files use `.ts` extension.
