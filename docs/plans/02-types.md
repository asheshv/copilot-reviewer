# Task 02: Shared Types and Error Classes

[Back to Plan Index](./README.md) | Prev: [01 — Scaffolding](./01-scaffolding.md) | Next: [03 — Auth](./03-auth.md)

**Dependencies:** Task 1
**Spec ref:** [10 — Error Handling](../spec/10-error-handling.md), [04 — Client](../spec/04-copilot-client.md), [03 — Diff](../spec/03-diff-collection.md), [06 — Config](../spec/06-configuration.md), [07 — Review](../spec/07-review-orchestration.md)

**Files:**
- Create: `src/lib/types.ts`
- Test: `test/lib/types.test.ts`

---

- [ ] **Step 1: Write failing tests for error classes**

```typescript
// test/lib/types.test.ts
import { describe, it, expect } from "vitest";
import {
  CopilotReviewError, AuthError, DiffError, ClientError,
  ConfigError, ModelError, ReviewError, ParameterError,
} from "../../src/lib/types.js";

describe("CopilotReviewError", () => {
  it("extends Error with code, recoverable, and cause", () => {
    const cause = new Error("original");
    const err = new AuthError("no_token", "No token found", false, cause);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CopilotReviewError);
    expect(err).toBeInstanceOf(AuthError);
    expect(err.code).toBe("no_token");
    expect(err.message).toBe("No token found");
    expect(err.recoverable).toBe(false);
    expect(err.cause).toBe(cause);
    expect(err.name).toBe("AuthError");
  });
});

describe("AuthError", () => {
  it("supports authorizeUrl for model_auth code", () => {
    const err = new AuthError("model_auth", "Model needs auth", false);
    err.authorizeUrl = "https://github.com/authorize";
    expect(err.authorizeUrl).toBe("https://github.com/authorize");
  });
});

describe("DiffError", () => {
  it("creates with diff-specific codes and is not recoverable", () => {
    const err = new DiffError("empty_diff", "No changes found");
    expect(err.code).toBe("empty_diff");
    expect(err.recoverable).toBe(false);
  });
});

describe("ClientError", () => {
  it("supports status and retryAfter for rate limiting", () => {
    const err = new ClientError("rate_limited", "Rate limited", true);
    err.status = 429;
    err.retryAfter = 30;
    expect(err.recoverable).toBe(true);
    expect(err.status).toBe(429);
    expect(err.retryAfter).toBe(30);
  });
});

describe("ConfigError", () => {
  it("supports filePath field", () => {
    const err = new ConfigError("malformed_json", "Bad JSON");
    err.filePath = "~/.copilot-review/config.json";
    expect(err.filePath).toBe("~/.copilot-review/config.json");
  });
});

describe("ModelError", () => {
  it("supports available model list", () => {
    const err = new ModelError("model_not_found", "Not found", false);
    err.available = ["gpt-4.1", "gpt-4o"];
    expect(err.available).toEqual(["gpt-4.1", "gpt-4o"]);
  });
});

describe("ReviewError", () => {
  it("supports suggestion field", () => {
    const err = new ReviewError("diff_too_large", "Too large", false);
    err.suggestion = "Use ignorePaths";
    expect(err.suggestion).toBe("Use ignorePaths");
  });
});

describe("ParameterError", () => {
  it("creates with parameter-specific codes", () => {
    const err = new ParameterError("missing_parameter", "Mode 'pr' requires 'pr' parameter");
    expect(err.code).toBe("missing_parameter");
    expect(err.recoverable).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `types.ts` module not found.

- [ ] **Step 3: Implement types.ts**

This is the largest single file. It contains ALL shared interfaces and error classes used across the project. Read the following spec files for exact definitions:

- **Error classes** (spec 10): `CopilotReviewError` base → `AuthError`, `DiffError`, `ClientError`, `ConfigError`, `ModelError`, `ReviewError`, `ParameterError`
- **Auth types** (spec 02/04): `AuthProvider` interface
- **Message types** (spec 04): `Message`, `ToolCall`
- **Client types** (spec 04): `ChatRequest`, `ChatResponse`, `StreamChunk`
- **Model types** (spec 05): `ModelInfo`
- **Diff types** (spec 03): `DiffOptions`, `DiffResult`, `FileChange`
- **Config types** (spec 06): `ConfigFile`, `ResolvedConfig`, `CLIOverrides`
- **Review types** (spec 07): `ReviewOptions`, `ReviewResult`, `ReviewStreamResult`
- **Output types** (spec 11): `OutputFormat`
- **Constants**: `EXIT_CODES`

Each error class extends `CopilotReviewError` and adds type-specific optional fields (e.g., `AuthError.authorizeUrl`, `ClientError.status`, `ClientError.retryAfter`, `ModelError.available`).

`StreamChunk.type` must include `"warning"` in addition to the types in spec 04 (needed for NDJSON streaming format per spec 11). This is a plan-level extension — spec 04 only defines `content | reasoning | error | done`, but the formatter needs `warning` for NDJSON warning chunks.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/types.ts test/lib/types.test.ts
git commit -m "feat: shared type definitions and error class hierarchy"
```
