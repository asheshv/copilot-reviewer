# Task 14: README

[Back to Plan Index](./README.md) | Prev: [13 — MCP Server](./13-mcp-server.md) | Next: [15 — Verification](./15-verification.md)

**Dependencies:** Tasks 12 (CLI), 13 (MCP Server)
**Spec ref:** All specs

**Files:**
- Create: `README.md`

---

- [ ] **Step 1: Write README.md**

Sections:

### Title + Badge
```markdown
# llm-reviewer
Review code changes using LLMs — CLI + MCP server.
```

### Installation
```bash
npm install -g llm-reviewer
# or
npx llm-reviewer --help
```

### Quick Start
3 examples: review local changes, review a branch, review a PR.

### CLI Usage
Full usage block from spec 08. All 7 modes, all flags, subcommands.

### MCP Server Setup
Configuration snippets for:
- Claude Code: `.mcp.json`
- Generic MCP client: `llm-reviewer --mcp`

### Configuration
4-layer config explanation. `config.json` schema (from spec 06). `config.md` prompt override. `extend` vs `replace` mode with examples.

### Default Review Prompt
Summary: what it checks (Security > Correctness > Performance > Readability > Simplicity). How to customize.

### Output Formats
Markdown, text, JSON, NDJSON examples.

### Exit Codes
Table from spec 08.

### Authentication
Token sources in priority order. How to set up.

### Development
```bash
git clone ...
npm install
npm test
npm run build
```

### License
MIT

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README with usage, configuration, and MCP setup"
```
