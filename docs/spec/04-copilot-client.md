# 04 — Copilot Client

[Back to Spec Index](./README.md) | Prev: [03 — Diff Collection](./03-diff-collection.md) | Next: [05 — Model Management](./05-model-management.md)

> API details: [Copilot API Reference](../reference/copilot-api-reference.md)

---

## Overview

`CopilotClient` wraps the GitHub Copilot chat API. It auto-routes between two API formats based on the model's capabilities and presents a unified interface to consumers.

## Endpoint Routing

Per model's `supported_endpoints` from the `/models` response (see [05 — Model Management](./05-model-management.md)):

| Model supports | Endpoint | Key differences |
|---------------|----------|-----------------|
| `"/responses"` | `POST /responses` | `instructions` field for system prompt, `input` array, flat tool format |
| Otherwise | `POST /chat/completions` | `messages` array with `role: "system"`, nested `{function: {}}` tool format |

### o1 Model Handling

Models with ID starting with `o1`:
- Demote `role: "system"` to `role: "user"` (o1 doesn't support system role)
- Omit `temperature`, `n`, `top_p` parameters

## Public Interface

```typescript
/** Abstraction over auth.ts — enables testing with mock auth */
interface AuthProvider {
  getAuthenticatedHeaders(): Promise<Record<string, string>>;
}

class CopilotClient {
  constructor(auth: AuthProvider);

  /** Non-streaming — returns complete response */
  chat(request: ChatRequest): Promise<ChatResponse>;

  /** Streaming — yields chunks as they arrive */
  chatStream(request: ChatRequest): AsyncIterable<StreamChunk>;
}

interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];   // future: tool calling loop
  tool_call_id?: string;     // future: tool result messages
}

interface ChatRequest {
  model: string;
  systemPrompt: string;
  messages: Message[];
  stream: boolean;
  maxTokens?: number;
}

interface ChatResponse {
  content: string;
  model: string;         // actual model used (may differ if auto-selected or load-balanced)
  usage: { totalTokens: number };
}

interface StreamChunk {
  type: "content" | "reasoning" | "error" | "done";
  text?: string;
  usage?: { totalTokens: number };
  model?: string;
}
```

Consumers call `chat()` or `chatStream()` — the client picks the right API format internally.

## Required Headers

Every request to `api.githubcopilot.com`:

```
Authorization: Bearer <session_token>
Editor-Version: copilot-reviewer/1.0.0
Editor-Plugin-Version: copilot-reviewer/1.0.0
Copilot-Integration-Id: vscode-chat
x-github-api-version: 2025-10-01
Content-Type: application/json
```

Auth headers are provided by [auth.ts](./02-authentication.md) via `getAuthenticatedHeaders()`.

> `Copilot-Integration-Id: vscode-chat` — using the known working value from the API reference. If Copilot starts rejecting it, this is the first thing to investigate.

### Conditional Header (future — tool calling)

```
x-initiator: agent
```

Set when the request contains tool call results. Condition differs by API format:
- Chat Completions: last message has `role: "tool"`
- Responses API: last input item has `type: "function_call_output"`

Not used in v1 (no tool calling loop), but documented here for future implementation.

## HTTP Transport Config

```
Connect timeout:     10 seconds
Overall timeout:     30 seconds
TCP keepalive:       60 seconds
Response buffering:  disabled (for streaming)
```

These match the recommended defaults from the [API reference](../reference/copilot-api-reference.md).

## Rate Limit Headers

Responses from `api.githubcopilot.com` may include:

```
x-ratelimit-limit: 5000
x-ratelimit-remaining: 4999
x-ratelimit-used: 1
x-ratelimit-reset: 1711234567    (UTC epoch)
x-ratelimit-resource: core
```

The client should:
- Log `x-ratelimit-remaining` for debugging
- Use `x-ratelimit-reset` in error messages ("Retry after <time>") when 429'd
- Honor `retry-after` header (seconds to wait) when present

> Note: Copilot-specific endpoints may have different rate limits than the general GitHub API. Inspect response headers empirically.

### Secondary Rate Limits

GitHub also enforces abuse-prevention limits that can cause **403** responses even when `x-ratelimit-remaining > 0`:
- Max 100 concurrent requests
- Max 80 content-generating requests per minute
- Max 900 points per minute on REST endpoints

If 403 is received with rate limit context, treat as rate-limited and apply exponential backoff with longer delays.

## SSE Streaming Parser (`streaming.ts`)

Two SSE formats normalized into unified `StreamChunk`:

### Chat Completions SSE

```
data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}
data: {"choices":[{"delta":{"content":" world"},"finish_reason":null}]}
data: {"choices":[{"finish_reason":"stop"}],"usage":{"total_tokens":150}}
data: [DONE]
```

Mapping:
- `delta.content` → `{ type: "content", text }`
- `delta.reasoning` or `delta.reasoning_content` → `{ type: "reasoning", text }` (check both field names in streaming AND non-streaming modes)
- `finish_reason: "stop"` OR `done_reason: "stop"` → `{ type: "done", usage, model }` (check both field names — different providers may use either)
- `finish_reason: "tool_calls"` → ignore in v1 (no tool calling loop)
- Any other `finish_reason` value → treat as abnormal termination → `{ type: "error" }`
- `data: [DONE]` → stream termination
- Stream ends without `[DONE]` or valid finish_reason → `ClientError { code: "stream_interrupted" }`, attempt line-by-line body parsing as recovery

### Responses API SSE

```
data: {"type":"response.output_text.delta","delta":"Hello"}
data: {"type":"response.completed","response":{"usage":{"total_tokens":150}}}
```

Mapping:
- `response.output_text.delta` → `{ type: "content", text }` — **note:** `delta` can be a string OR `{text: "..."}` object. Parser must handle both forms.
- `response.completed` or `response.done` → `{ type: "done", usage, model }`
- `response.failed` → `{ type: "error", text: error.message }`

### SSE Parser

```typescript
parseSSEStream(body: ReadableStream): AsyncIterable<object>
```

- Splits on `data: ` lines
- Handles `data: [DONE]` termination
- Yields parsed JSON objects
- Skips malformed lines gracefully

## Non-Streaming Response Parsing

### Chat Completions (non-streaming)

```json
{
  "choices": [{
    "message": { "role": "assistant", "content": "...", "reasoning": "..." },
    "finish_reason": "stop"
  }],
  "usage": { "total_tokens": 150 },
  "model": "gpt-4.1"
}
```

- Extract content from `choices[0].message.content`
- Check both `choices[0].finish_reason` AND `choices[0].done_reason` (different providers use either)
- Check both `message.reasoning` AND `message.reasoning_content` for reasoning output
- `usage.total_tokens` may be at top-level or per-choice

### Responses API (non-streaming)

```json
{
  "response": {
    "status": "completed",
    "output": [{ "role": "assistant", "content": [{ "type": "output_text", "text": "..." }] }],
    "usage": { "total_tokens": 150 },
    "model": "gpt-4.1",
    "reasoning": { "summary": "..." }
  }
}
```

- Check `response.status == "completed"`. If `"failed"` or other → `ClientError { code: "request_failed" }` with `error.message` if available.
- Extract text from `response.output[].content[]` — filter items where `type` is `"output_text"`, `"text"`, or `"input_text"`.
- Reasoning summary in `response.reasoning.summary` (if present).

## Response Validation

All response field accesses must be null-safe (optional chaining). If expected fields are missing (e.g., `choices[0]` doesn't exist in non-streaming response), throw `ClientError { code: "invalid_response" }` with the raw response body for debugging. This protects against API changes to the undocumented endpoints.

## Retry Logic

| Status | Action |
|--------|--------|
| 429 (rate limited) | Retry, honor `retry-after` header |
| 502, 503, 504 | Retry with backoff |
| Network timeout | Retry (same as server error) |
| 401 with `authorize_url` | `AuthError { code: "model_auth", authorizeUrl }` — no retry |
| Other non-2xx | `ClientError` — no retry |

**Strategy:**
- Max 2 retries
- Exponential backoff with jitter: `min(max_backoff, base * 2^attempt) * random(0.5, 1.5)`
- Honor `retry-after` header when present
- Cap total retry time at 120 seconds

See [10 — Error Handling](./10-error-handling.md) for error types.

## No Tool Calling Loop in v1

The review use case is one-shot: send diff + prompt, get response. Copilot can request tool calls (e.g., asking to read additional files), but v1 does not implement the tool calling loop. This is documented as a [future enhancement](./14-future.md).

### Tool Call Streaming (future reference)

When tool calling is implemented, Chat Completions tool calls arrive incrementally:
- Use `index` field as key to track each tool call
- `id` and `name` arrive in the first chunk for that index
- `arguments` is concatenated across multiple chunks for the same index
- `finish_reason: "tool_calls"` signals all tool calls are complete

Responses API tool calls arrive as complete items via `response.output_item.done` — no incremental accumulation needed.

See [Copilot API Reference](../reference/copilot-api-reference.md) for the full protocol.
