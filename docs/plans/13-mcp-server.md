# Task 13: MCP Server

[Back to Plan Index](./README.md) | Prev: [12 — CLI](./12-cli.md) | Next: [14 — README](./14-readme.md)

**Dependencies:** Task 11 (exports)
**Spec ref:** [09 — MCP Server](../spec/09-mcp-server.md)

**Files:**
- Create: `src/mcp-server.ts`
- Test: `test/mcp-server.test.ts`

---

- [ ] **Step 1: Write failing tests**

Use MCP SDK test client for testing.

```typescript
describe("MCP Server", () => {
  describe("tool registration", () => {
    it("registers copilot_review tool");
    it("registers copilot_chat tool");
    it("registers copilot_models tool");
  });

  describe("copilot_review", () => {
    describe("parameter validation", () => {
      it("rejects invalid mode with invalid_parameter error");
      it("rejects pr mode without pr param with missing_parameter error");
      it("rejects range mode without range param");
      it("rejects commits mode without count param");
    });

    it("returns structured result on success with content, model, usage, diff, warnings");
    it("returns structured error with isError true on auth failure");
    it("returns structured error with isError true on diff failure");
    it("maps tool parameters to ReviewOptions correctly");
  });

  describe("copilot_chat", () => {
    it("calls client.chat with empty systemPrompt when no context");
    it("uses context as systemPrompt when provided");
    it("returns content, model, usage");
  });

  describe("copilot_models", () => {
    it("returns model list with id, name, endpoints, capabilities");
  });

  describe("resilience", () => {
    it("server stays alive after error in tool handler");
    it("handles sequential tool calls (no concurrency issues)");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL.

- [ ] **Step 3: Implement mcp-server.ts**

Use `@modelcontextprotocol/sdk` with stdio transport.

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export async function startServer() {
  const server = new Server({ name: "copilot-reviewer", version: "0.1.0" }, {
    capabilities: { tools: {} },
  });

  // Register tools
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: "copilot_review",
        description: "Review code changes using GitHub Copilot",
        inputSchema: { /* JSON Schema for mode, base, pr, range, count, model, prompt */ },
      },
      {
        name: "copilot_chat",
        description: "Chat with GitHub Copilot about code",
        inputSchema: { /* JSON Schema for message, context, model */ },
      },
      {
        name: "copilot_models",
        description: "List available GitHub Copilot models",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      switch (request.params.name) {
        case "copilot_review": return await handleReview(request.params.arguments);
        case "copilot_chat": return await handleChat(request.params.arguments);
        case "copilot_models": return await handleModels();
        default: return { isError: true, content: [{ type: "text", text: "Unknown tool" }] };
      }
    } catch (err) {
      return mapErrorToToolResult(err);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

Key implementation details:
- `handleReview(params)`: validate parameters → `loadConfig({ prompt, model })` → build `ReviewOptions` (per spec mapping) → call `review(options)` → return structured result
- `handleChat(params)`: resolve model → `client.chat({ systemPrompt: context || "", messages: [{ role: "user", content: message }], ... })` → return result
- `handleModels()`: `models.listModels()` → return structured list
- `mapErrorToToolResult(err)`: catch `CopilotReviewError` → `{ isError: true, content: [{ type: "text", text: JSON.stringify({ error, message, recoverable, raw }) }] }`
- Parameter validation before calling lib (invalid mode, missing required params for mode-specific params)

Never throw — all errors caught and returned as structured tool results.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: All MCP server tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server.ts test/mcp-server.test.ts
git commit -m "feat: MCP server with review, chat, and models tools"
```
