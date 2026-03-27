# Task 06: Model Management

[Back to Plan Index](./README.md) | Prev: [05 — Client](./05-client.md) | Next: [07 — Diff](./07-diff.md)

**Dependencies:** Task 5 (client)
**Spec ref:** [05 — Model Management](../spec/05-model-management.md)

**Files:**
- Create: `src/lib/models.ts`
- Test: `test/lib/models.test.ts`

---

- [ ] **Step 1: Write failing tests**

```typescript
describe("ModelManager", () => {
  describe("listModels()", () => {
    it("fetches from /models and returns ModelInfo array");
    it("filters to capabilities.type chat and model_picker_enabled");
    it("deduplicates by name, keeps highest version");
    it("auto-enables models with disabled policy via POST /models/{id}/policy");
    it("skips policy check when policy field is absent");
    it("caches results for 300 seconds");
    it("re-fetches after cache TTL expires");
  });

  describe("autoSelect()", () => {
    it("calls POST /models/session with auto hints");
    it("returns selected_model string");
    it("throws ModelError auto_select_failed on API error");
  });

  describe("validateModel()", () => {
    it("returns ModelInfo for valid model ID");
    it("throws ModelError model_not_found with available list for invalid ID");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL.

- [ ] **Step 3: Implement models.ts**

`ModelManager` class:
- Constructor: takes `CopilotClient` (for making API calls)
- `listModels(): Promise<ModelInfo[]>` — fetch, filter, deduplicate, cache
- `autoSelect(): Promise<string>` — POST /models/session
- `validateModel(id: string): Promise<ModelInfo>` — list + find or throw
- Private: `_cache: ModelInfo[] | null`, `_cacheExpiry: number`
- Private: `_enablePolicy(id: string): Promise<void>`

Cache TTL: 300 seconds (5 minutes). Store `Date.now() + 300_000` as expiry.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: All model tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/models.ts test/lib/models.test.ts
git commit -m "feat: model management with listing, validation, auto-selection, caching"
```
