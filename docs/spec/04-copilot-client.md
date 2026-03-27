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
class CopilotClient {
  constructor(auth: AuthProvider);

  /** Non-streaming — returns complete response */
  chat(request: ChatRequest): Promise<ChatResponse>;

  /** Streaming — yields chunks as they arrive */
  chatStream(request: ChatRequest): AsyncIterable<StreamChunk>;
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
- `delta.reasoning` or `delta.reasoning_content` → `{ type: "reasoning", text }`
- `finish_reason: "stop"` → `{ type: "done", usage, model }`
- `data: [DONE]` → stream termination

### Responses API SSE

```
data: {"type":"response.output_text.delta","delta":"Hello"}
data: {"type":"response.completed","response":{"usage":{"total_tokens":150}}}
```

Mapping:
- `response.output_text.delta` → `{ type: "content", text }`
- `response.completed` → `{ type: "done", usage, model }`
- `response.failed` → `{ type: "error", text: error.message }`

### SSE Parser

```typescript
parseSSEStream(body: ReadableStream): AsyncIterable<object>
```

- Splits on `data: ` lines
- Handles `data: [DONE]` termination
- Yields parsed JSON objects
- Skips malformed lines gracefully

## Retry Logic

| Status | Action |
|--------|--------|
| 429 (rate limited) | Retry, honor `retry-after` header |
| 502, 503, 504 | Retry with backoff |
| 401 with `authorize_url` | `AuthError { code: "model_auth", authorizeUrl }` — no retry |
| Other non-2xx | `ClientError` — no retry |

**Strategy:**
- Max 2 retries
- Exponential backoff with jitter: `min(max_backoff, base * 2^attempt) * random(0.5, 1.5)`
- Honor `retry-after` header when present

See [10 — Error Handling](./10-error-handling.md) for error types.

## No Tool Calling Loop in v1

The review use case is one-shot: send diff + prompt, get response. Copilot can request tool calls (e.g., asking to read additional files), but v1 does not implement the tool calling loop. This is documented as a [future enhancement](./14-future.md).
