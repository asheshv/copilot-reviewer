# Task 07: Diff Collection

[Back to Plan Index](./README.md) | Prev: [06 — Models](./06-models.md) | Next: [08 — Config+Prompt](./08-config-prompt.md)

**Dependencies:** Task 2 (types)
**Spec ref:** [03 — Diff Collection](../spec/03-diff-collection.md)

**Files:**
- Create: `src/lib/diff.ts`
- Test: `test/lib/diff.test.ts`
- Create: `test/fixtures/diffs/` (sample git diff outputs)

---

- [ ] **Step 1: Create diff fixtures**

Create `test/fixtures/diffs/`:

**`simple-modify.diff`:** Single file modification with stats.
**`multi-file.diff`:** 3+ files changed with adds, modifies, deletes.
**`rename.diff`:** File rename (rename from/to).
**`binary.diff`:** Contains "Binary files ... differ" line.
**`empty.diff`:** Empty string (no changes).

- [ ] **Step 2: Write failing tests**

Mock child process spawning for git commands. Key test cases:

```typescript
describe("collectDiff", () => {
  describe("mode to command mapping", () => {
    it("unstaged -> git diff");
    it("staged -> git diff --cached");
    it("local -> git diff HEAD");
    it("branch -> git diff <base>...HEAD");
    it("pr -> gh pr diff <number> --patch");
    it("commits -> git diff HEAD~<n>..HEAD");
    it("range -> git diff <ref1>..<ref2>");
  });

  describe("result parsing", () => {
    it("extracts raw diff text");
    it("parses file list with status and stats");
    it("detects binary files in metadata, excludes from raw");
    it("captures renamed files with oldPath and path");
  });

  describe("ignorePaths filtering", () => {
    it("excludes matched files from raw and files metadata");
    it("updates stats after filtering");
    it("handles glob patterns (e.g., *.lock, vendor/**)");
  });

  describe("validations and errors", () => {
    it("throws git_not_installed when git binary not found");
    it("throws not_git_repo when not inside git repo");
    it("throws gh_not_installed for pr mode without gh");
    it("throws empty_diff when diff output is empty");
    it("throws base_not_found when base branch missing");
    it("throws pr_not_found for invalid PR number");
    it("throws invalid_ref for nonexistent refs in range mode");
    it("throws insufficient_history for shallow clone with HEAD~N");
    it("throws no_commits when repo has no commits");
    it("throws diff_too_large when raw exceeds 10 MB");
    it("respects COPILOT_REVIEW_MAX_DIFF_SIZE env var for size limit");
  });

  describe("security", () => {
    it("passes user input as array arguments, not interpolated into strings");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL.

- [ ] **Step 4: Implement diff.ts**

`collectDiff(options: DiffOptions): Promise<DiffResult>`:

1. Validate prerequisites (git installed, in repo, etc.)
2. Build command + args based on mode
3. Spawn process with array arguments (safe, no shell)
4. Parse diff output:
   - Split on `diff --git` markers
   - Extract file paths, status (add/modify/delete/rename)
   - Count insertions/deletions per file
   - Detect binary files ("Binary files" line)
5. Apply `ignorePaths` filter (glob match with `minimatch` or manual pattern matching — prefer no extra dependency, use simple glob matching)
6. Check size limit (`COPILOT_REVIEW_MAX_DIFF_SIZE` env var, default 10 MB)
7. Detect git error patterns in stderr:
   - "not a git repository" → `not_git_repo`
   - "unknown revision" with HEAD → `no_commits`
   - "unknown revision" with `HEAD~` → `insufficient_history`
   - "unknown revision" with ref → `invalid_ref`

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: All diff tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/diff.ts test/lib/diff.test.ts test/fixtures/diffs/
git commit -m "feat: diff collection with 7 modes, validation, and filtering"
```
