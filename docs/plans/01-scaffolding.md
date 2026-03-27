# Task 01: Project Scaffolding

[Back to Plan Index](./README.md) | Next: [02 — Types](./02-types.md)

**Dependencies:** None
**Spec ref:** [01 — Architecture](../spec/01-architecture.md)

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `LICENSE`
- Create: `src/lib/index.ts` (minimal, for build verification)
- Test: `test/lib/smoke.test.ts` (verify infrastructure works)

---

- [ ] **Step 1: Create package.json**

```json
{
  "name": "copilot-reviewer",
  "version": "0.1.0",
  "description": "Review code changes using GitHub Copilot",
  "type": "module",
  "main": "dist/lib/index.js",
  "types": "dist/lib/index.d.ts",
  "bin": {
    "copilot-review": "dist/cli.js"
  },
  "files": [
    "dist/",
    "prompts/"
  ],
  "engines": {
    "node": ">=18.0.0"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "tsc --noEmit"
  },
  "license": "MIT",
  "devDependencies": {
    "@types/node": "^20.0.0",
    "msw": "^2.0.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "commander": "^12.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "test"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: Create .gitignore**

```
node_modules/
dist/
*.log
.env
.DS_Store
```

- [ ] **Step 5: Create LICENSE**

Standard MIT license, year 2026, author "Ashesh Vashi".

- [ ] **Step 6: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, `package-lock.json` generated.

- [ ] **Step 7: Create minimal src/lib/index.ts and verify build**

```typescript
export const VERSION = "0.1.0";
```

Run: `npm run build`
Expected: `dist/lib/index.js` and `dist/lib/index.d.ts` created.

- [ ] **Step 8: Create smoke test and verify test infrastructure**

```typescript
// test/lib/smoke.test.ts
import { describe, it, expect } from "vitest";
import { VERSION } from "../../src/lib/index.js";

describe("smoke test", () => {
  it("exports VERSION", () => {
    expect(VERSION).toBe("0.1.0");
  });
});
```

Run: `npm test`
Expected: 1 test passes.

- [ ] **Step 9: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore LICENSE src/lib/index.ts test/lib/smoke.test.ts package-lock.json
git commit -m "feat: project scaffolding with build and test infrastructure"
```
