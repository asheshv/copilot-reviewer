# 03 — Diff Collection

[Back to Spec Index](./README.md) | Prev: [02 — Authentication](./02-authentication.md) | Next: [04 — Copilot Client](./04-copilot-client.md)

---

## Seven Diff Modes

| Mode | Git Command | CLI Usage | Notes |
|------|------------|-----------|-------|
| `unstaged` | `git diff` | `copilot-review unstaged` | Working tree vs index |
| `staged` | `git diff --cached` | `copilot-review staged` | Index vs HEAD |
| `local` | `git diff HEAD` | `copilot-review local` | **Default.** Staged + unstaged |
| `branch` | `git diff <base>...HEAD` | `copilot-review branch [base]` | Uses `defaultBase` from [config](./06-configuration.md) if no base specified |
| `pr` | `gh pr diff <number> --patch` | `copilot-review pr <number>` | Requires `gh` CLI |
| `commits` | `git diff HEAD~<n>..HEAD` | `copilot-review commits <n>` | Last N commits |
| `range` | `git diff <ref1>..<ref2>` | `copilot-review range <ref1>..<ref2>` | Arbitrary ref range |

## Interface

```typescript
interface DiffOptions {
  mode: "unstaged" | "staged" | "local" | "branch" | "pr" | "commits" | "range";
  base?: string;       // for "branch" mode
  pr?: number;         // for "pr" mode
  range?: string;      // for "range" mode
  count?: number;      // for "commits" mode (HEAD~N)
  ignorePaths?: string[];  // glob patterns to exclude (from config)
}

interface DiffResult {
  raw: string;                  // full diff text (sent to Copilot)
  files: FileChange[];          // parsed file list
  stats: {
    filesChanged: number;
    insertions: number;
    deletions: number;
  };
}

interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  oldPath?: string;             // for renames
  insertions: number;
  deletions: number;
}
```

## Public API

```typescript
collectDiff(options: DiffOptions): Promise<DiffResult>
```

Returns both raw diff text (sent to Copilot) and parsed metadata (used by [formatter](./11-formatter.md) and [MCP server](./09-mcp-server.md)).

## Validations

| Check | When | Error |
|-------|------|-------|
| `git` binary available | All modes except `pr` | `DiffError { code: "git_not_installed" }` |
| Inside a git repo | All modes except `pr` | `DiffError { code: "not_git_repo" }` |
| `gh` CLI available | `pr` mode only | `DiffError { code: "gh_not_installed" }` |
| Diff is non-empty | All modes | `DiffError { code: "empty_diff" }` |
| Base branch exists | `branch` mode | `DiffError { code: "base_not_found" }` |
| PR number valid | `pr` mode | `DiffError { code: "pr_not_found" }` |
| Refs exist | `range` mode | `DiffError { code: "invalid_ref" }` |

## Edge Cases

### Binary Files
Detected via diff output. Listed in `files` metadata with their status, but binary content is excluded from `raw` diff. Git's default diff output already includes "Binary files ... differ" lines — these are preserved in `raw`. The diff module does NOT add additional notes; the formatter handles presentation.

### Large Diffs
No truncation in this module. If a diff is likely to exceed the model's token budget, that's [review.ts](./07-review-orchestration.md)'s concern — it knows the model's limits and can warn the user.

### Renamed Files
Captured as `status: "renamed"` with both `oldPath` (original) and `path` (new). Both paths appear in the diff.

### `ignorePaths` Filtering
`ignorePaths` is passed via `DiffOptions.ignorePaths` (populated from [config](./06-configuration.md) by `review.ts`). Filtering is applied as post-processing after the git diff runs — matched files are excluded from both `raw` diff and `files` metadata. Applied after git command returns, not via git pathspecs.

### Diff Size Limit
If `raw` diff exceeds **10 MB** (configurable via `COPILOT_REVIEW_MAX_DIFF_SIZE` env var), fail immediately with `DiffError { code: "diff_too_large" }` before any further processing. Prevents OOM on accidentally committed binaries.

## Security

All git commands executed via `child_process.execFile` (array arguments, no shell interpolation) to prevent injection. User-provided values (branch names, ref ranges) are passed as separate arguments, never concatenated into a command string.

**Secrets warning:** Diffs are sent to the GitHub Copilot API as-is. Users are responsible for ensuring diffs don't contain secrets (API keys, tokens, passwords). A future enhancement may add pre-scan warning for common secret patterns.
