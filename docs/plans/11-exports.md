# Task 11: Public API Exports

[Back to Plan Index](./README.md) | Prev: [10 — Review](./10-review.md) | Next: [12 — CLI](./12-cli.md)

**Dependencies:** Tasks 2-10 (all lib modules)
**Spec ref:** [01 — Architecture](../spec/01-architecture.md)

**Files:**
- Modify: `src/lib/index.ts`
- Delete: `test/lib/smoke.test.ts` (replaced by real tests)

---

- [ ] **Step 1: Update src/lib/index.ts with all public exports**

```typescript
// src/lib/index.ts

// Types and error classes
export * from "./types.js";

// Auth
export { createDefaultAuthProvider, getAuthenticatedHeaders } from "./auth.js";

// Client
export { CopilotClient } from "./client.js";

// Streaming
export { parseSSEStream, parseChatCompletionChunk, parseResponsesChunk } from "./streaming.js";

// Models
export { ModelManager } from "./models.js";

// Diff
export { collectDiff } from "./diff.js";

// Config
export { loadConfig } from "./config.js";

// Prompt
export { loadBuiltInPrompt, assembleUserMessage } from "./prompt.js";

// Formatter
export { format, formatNdjsonChunk, detectHighSeverity } from "./formatter.js";

// Review
export { review, reviewStream } from "./review.js";
```

Note: adjust the exact export names to match what was actually implemented in tasks 3-10. The names above are based on the spec — the actual implementation may use slightly different names (e.g., `createReviewPipeline` instead of `review`).

- [ ] **Step 2: Delete smoke test**

Remove `test/lib/smoke.test.ts` — it was a scaffolding artifact, now replaced by real tests.

- [ ] **Step 3: Verify build passes**

Run: `npm run build`
Expected: Clean build, zero errors. All modules compile and type-check.

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: All tests pass (every test from tasks 2-10).

- [ ] **Step 5: Commit**

```bash
git add src/lib/index.ts
git rm test/lib/smoke.test.ts
git commit -m "feat: public API exports from lib/index.ts"
```
