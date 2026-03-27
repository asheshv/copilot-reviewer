# Task 04: SSE Streaming Parser

[Back to Plan Index](./README.md) | Prev: [03 — Auth](./03-auth.md) | Next: [05 — Client](./05-client.md)

**Dependencies:** Task 2
**Spec ref:** [04 — Copilot Client](../spec/04-copilot-client.md) — SSE Streaming Parser section

**Files:**
- Create: `src/lib/streaming.ts`
- Test: `test/lib/streaming.test.ts`
- Create: `test/fixtures/responses/` (SSE fixture files)

---

- [ ] **Step 1: Create test fixtures**

Create `test/fixtures/responses/`:

**`chat-completions-streaming.txt`:**
```
data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}
data: {"choices":[{"delta":{"content":" world"},"finish_reason":null}]}
data: {"choices":[{"finish_reason":"stop"}],"usage":{"total_tokens":150},"model":"gpt-4.1"}
data: [DONE]
```

**`chat-completions-reasoning.txt`:**
```
data: {"choices":[{"delta":{"reasoning_content":"Let me think..."},"finish_reason":null}]}
data: {"choices":[{"delta":{"content":"The answer is 42."},"finish_reason":null}]}
data: {"choices":[{"finish_reason":"stop"}],"usage":{"total_tokens":200}}
data: [DONE]
```

**`responses-api-streaming.txt`:**
```
data: {"type":"response.output_text.delta","delta":"Hello"}
data: {"type":"response.output_text.delta","delta":" world"}
data: {"type":"response.completed","response":{"status":"completed","usage":{"total_tokens":150},"model":"gpt-4.1"}}
```

**`responses-api-delta-object.txt`:**
```
data: {"type":"response.output_text.delta","delta":{"text":"Hello object"}}
data: {"type":"response.completed","response":{"status":"completed","usage":{"total_tokens":100}}}
```

**`chat-completions-abnormal.txt`:**
```
data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}
data: {"choices":[{"finish_reason":"content_filter"}]}
```

- [ ] **Step 2: Write failing tests**

```typescript
describe("parseSSEStream", () => {
  it("yields parsed JSON objects from SSE data lines");
  it("handles data: [DONE] as stream termination");
  it("skips empty lines and comment lines");
  it("skips malformed JSON lines gracefully");
});

describe("parseChatCompletionChunk", () => {
  it("extracts delta.content as content chunk");
  it("extracts delta.reasoning as reasoning chunk");
  it("extracts delta.reasoning_content as reasoning chunk");
  it("maps finish_reason stop to done chunk with usage");
  it("maps done_reason stop to done chunk (alternative field name)");
  it("maps abnormal finish_reason to error chunk");
  it("ignores finish_reason tool_calls in v1");
  it("returns null for chunks with no actionable data");
});

describe("parseResponsesChunk", () => {
  it("extracts output_text.delta string as content chunk");
  it("extracts output_text.delta object {text} as content chunk");
  it("maps response.completed to done chunk with usage and model");
  it("maps response.done to done chunk");
  it("maps response.failed to error chunk with message");
});
```

Helper to create `ReadableStream` from fixture text for testing:

```typescript
import { Readable } from "node:stream";
import { readFileSync } from "node:fs";

function fixtureToStream(fixturePath: string): ReadableStream {
  const text = readFileSync(fixturePath, "utf-8");
  const readable = Readable.from([new TextEncoder().encode(text)]);
  return Readable.toWeb(readable) as ReadableStream;
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL.

- [ ] **Step 4: Implement streaming.ts**

Three exports:
- `parseSSEStream(body: ReadableStream): AsyncIterable<object>` — reads lines, splits on `data: `, parses JSON, skips malformed, terminates on `[DONE]`
- `parseChatCompletionChunk(chunk: object): StreamChunk | null` — normalizes Chat Completions SSE into `StreamChunk`. Checks BOTH `finish_reason` and `done_reason`.
- `parseResponsesChunk(chunk: object): StreamChunk | null` — normalizes Responses API SSE into `StreamChunk`. Handles delta as string OR `{text: "..."}` object.

All field accesses use optional chaining (`?.`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: All streaming tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/streaming.ts test/lib/streaming.test.ts test/fixtures/responses/
git commit -m "feat: SSE streaming parser for Chat Completions and Responses API"
```
