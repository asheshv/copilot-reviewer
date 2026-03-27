# Task 05: Copilot API Client

[Back to Plan Index](./README.md) | Prev: [04 — Streaming](./04-streaming.md) | Next: [06 — Models](./06-models.md)

**Dependencies:** Tasks 3 (auth), 4 (streaming)
**Spec ref:** [04 — Copilot Client](../spec/04-copilot-client.md)

**Files:**
- Create: `src/lib/client.ts`
- Test: `test/lib/client.test.ts`
- Create: `test/fixtures/responses/chat-completions-non-streaming.json`
- Create: `test/fixtures/responses/responses-api-non-streaming.json`

---

- [ ] **Step 1: Create non-streaming response fixtures**

**`chat-completions-non-streaming.json`:**
```json
{
  "choices": [{
    "message": { "role": "assistant", "content": "Review findings here.", "reasoning": "I analyzed the code." },
    "finish_reason": "stop"
  }],
  "usage": { "total_tokens": 150 },
  "model": "gpt-4.1"
}
```

**`responses-api-non-streaming.json`:**
```json
{
  "response": {
    "status": "completed",
    "output": [{
      "role": "assistant",
      "content": [{ "type": "output_text", "text": "Review findings here." }]
    }],
    "usage": { "total_tokens": 150 },
    "model": "gpt-4.1",
    "reasoning": { "summary": "I analyzed the code." }
  }
}
```

- [ ] **Step 2: Write failing tests**

Use `msw` (Mock Service Worker) for HTTP mocking. Key test cases:

```typescript
describe("CopilotClient", () => {
  describe("endpoint routing", () => {
    it("uses Responses API when model supports /responses");
    it("uses Chat Completions when model does not support /responses");
  });

  describe("o1 model handling", () => {
    it("demotes system role to user for o1 models");
    it("omits temperature, n, top_p for o1 models");
  });

  describe("required headers", () => {
    it("includes all 6 required headers on every request");
  });

  describe("chat() non-streaming", () => {
    it("parses Chat Completions response correctly");
    it("checks both finish_reason and done_reason fields");
    it("checks both reasoning and reasoning_content fields");
    it("parses Responses API response correctly");
    it("checks response.status for Responses API");
    it("extracts content from output[].content[] with multiple type values");
    it("handles empty systemPrompt (chat subcommand)");
  });

  describe("chatStream()", () => {
    it("returns AsyncIterable of StreamChunk");
    it("delegates to streaming.ts parsers based on API format");
  });

  describe("retry logic", () => {
    it("retries on 429 with retry-after header");
    it("retries on 502/503/504 with exponential backoff");
    it("retries on network timeout");
    it("max 2 retries then throws");
    it("does not retry on 401 with authorize_url");
    it("does not retry on other non-2xx");
  });

  describe("response validation", () => {
    it("throws invalid_response on missing choices[0]");
    it("throws invalid_response on unexpected response shape");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL.

- [ ] **Step 4: Implement client.ts**

`CopilotClient` class:
- Constructor: `constructor(auth: AuthProvider)`
- `chat(request: ChatRequest): Promise<ChatResponse>` — non-streaming
- `chatStream(request: ChatRequest): AsyncIterable<StreamChunk>` — streaming
- Private: `_buildChatCompletionsBody(request)`, `_buildResponsesBody(request)`
- Private: `_parseChatCompletionsResponse(json)`, `_parseResponsesApiResponse(json)`
- Private: `_buildHeaders()` — merges auth headers with required Copilot headers
- Private: `_retry<T>(fn: () => Promise<T>)` — retry wrapper with backoff + jitter

HTTP transport: 10s connect timeout (AbortController with setTimeout), 30s overall timeout. Uses built-in `fetch`.

Required headers per spec:
```
Editor-Version: copilot-reviewer/0.1.0
Editor-Plugin-Version: copilot-reviewer/0.1.0
Copilot-Integration-Id: vscode-chat
x-github-api-version: 2025-10-01
Content-Type: application/json
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: All client tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/client.ts test/lib/client.test.ts test/fixtures/responses/chat-completions-non-streaming.json test/fixtures/responses/responses-api-non-streaming.json
git commit -m "feat: Copilot API client with dual-format routing and retry"
```
