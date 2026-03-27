# Task 03: Authentication Module

[Back to Plan Index](./README.md) | Prev: [02 — Types](./02-types.md) | Next: [04 — Streaming](./04-streaming.md)

**Dependencies:** Task 2
**Spec ref:** [02 — Authentication](../spec/02-authentication.md)

**Files:**
- Create: `src/lib/auth.ts`
- Test: `test/lib/auth.test.ts`

---

- [ ] **Step 1: Write failing tests**

Mock `process.env`, `fs/promises`, and child process spawning. Setup:

```typescript
import { vi, describe, it, expect, beforeEach } from "vitest";
import { readFile } from "fs/promises";
import { execFile } from "child_process";

vi.mock("fs/promises", () => ({ readFile: vi.fn() }));
vi.mock("child_process", () => ({ execFile: vi.fn() }));

const mockReadFile = vi.mocked(readFile);
const mockExecFile = vi.mocked(execFile);

beforeEach(() => {
  vi.resetAllMocks();
  delete process.env.GITHUB_TOKEN;
});
```

Key test cases:

```typescript
describe("resolveToken", () => {
  it("returns $GITHUB_TOKEN when set");
  it("falls through to Copilot config when env var missing");
  it("parses hosts.json for github.com oauth_token");
  it("parses apps.json for github.com oauth_token");
  it("falls through to gh CLI when config files missing");
  it("calls gh auth token via safe process spawning (not shell-based)");
  it("throws AuthError no_token when all sources fail");
  it("expands ~ via os.homedir() for config paths");
});

describe("exchangeSessionToken", () => {
  it("exchanges OAuth token for session token via /copilot_internal/v2/token");
  it("caches session token in memory");
  it("returns cached token when not expired");
  it("re-fetches when token is expired");
  it("concurrent callers share one refresh (mutex)");
  it("throws AuthError exchange_failed on HTTP error");
});

describe("getAuthenticatedHeaders", () => {
  it("returns headers with Bearer session_token");
  it("never includes raw token values in error messages");
});

describe("createDefaultAuthProvider", () => {
  it("returns AuthProvider interface implementation");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `auth.ts` not found.

- [ ] **Step 3: Implement auth.ts**

Key implementation details:
- `resolveToken()`: check `process.env.GITHUB_TOKEN` then read `~/.config/github-copilot/hosts.json` and `apps.json` then spawn `gh auth token -h github.com`
- File reads: use `fs/promises.readFile`, expand `~` with `os.homedir()`
- `gh` CLI: use safe array-based process spawning (NOT shell-based), check binary exists first
- `exchangeSessionToken(oauthToken)`: fetch `https://api.github.com/copilot_internal/v2/token` with `Authorization: Token <oauthToken>`. Cache `{ token, expires_at }` in module-level variable. Mutex via a shared Promise for concurrent callers.
- `getAuthenticatedHeaders()`: chains `resolveToken()` then `exchangeSessionToken()` then returns `{ Authorization: "Bearer " + sessionToken }`
- Token redaction in all error messages: replace with first 4 chars + "..." + last 4 chars

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: All auth tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth.ts test/lib/auth.test.ts
git commit -m "feat: authentication with 3-source token resolution and session exchange"
```
