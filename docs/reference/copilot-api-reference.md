# GitHub Copilot Chat API Reference

Research notes for building a client that talks to GitHub Copilot's chat API.

> **Source disclaimer**: The Copilot-specific endpoints (`api.githubcopilot.com`, `api.github.com/copilot_internal/*`) are not publicly documented by GitHub. The response shapes, field names, and behaviors for these endpoints are **reverse-engineered from the CopilotChat.nvim client code** -- inferred from how the code parses responses, not from official API specs. Actual responses may contain additional fields not captured here. The device flow, rate limit headers, and subscription tiers are from official GitHub documentation and are authoritative.

---

## API Endpoints

### Copilot Provider (primary)

| Purpose | Method | URL | Auth |
|---------|--------|-----|------|
| **Exchange OAuth for session token** | `GET` | `https://api.github.com/copilot_internal/v2/token` | `Token <oauth_token>` |
| **User info / quota usage** | `GET` | `https://api.github.com/copilot_internal/user` | `Token <oauth_token>` |
| **List available models** | `GET` | `https://api.githubcopilot.com/models` | `Bearer <session_token>` |
| **Enable model policy** | `POST` | `https://api.githubcopilot.com/models/{id}/policy` | `Bearer <session_token>` |
| **Auto model selection** | `POST` | `https://api.githubcopilot.com/models/session` | `Bearer <session_token>` |
| **Chat (completions)** | `POST` | `https://api.githubcopilot.com/chat/completions` | `Bearer <session_token>` |
| **Chat (responses API)** | `POST` | `https://api.githubcopilot.com/responses` | `Bearer <session_token>` |

### GitHub Models Provider (alternative)

| Purpose | Method | URL | Auth |
|---------|--------|-----|------|
| **List models** | `GET` | `https://models.github.ai/catalog/models` | `Bearer <gh_token>` |
| **Chat completions** | `POST` | `https://models.github.ai/inference/chat/completions` | `Bearer <gh_token>` |

> Note: The GitHub Models provider only supports Chat Completions API -- there is no Responses API endpoint. It also has no model policy management, no auto model selection, and no model deduplication logic.

---

## Authentication

### Copilot provider: two-layer token scheme

The copilot provider requires two tokens:

```
OAuth token (long-lived, cached on disk)
  |
  |  GET https://api.github.com/copilot_internal/v2/token
  |  Headers: { "Authorization": "Token <oauth_token>" }
  |
  v
Session token (short-lived, returned with expires_at)
  |
  |  Used as: { "Authorization": "Bearer <session_token>" }
  |  For all requests to api.githubcopilot.com
  v
```

The session token response contains at minimum:
```json
{
  "token": "<opaque string>",
  "expires_at": 1711234567
}
```

> Note: The exact format of the `token` string is opaque and should not be parsed. Treat it as an opaque bearer token.

Cache the session token in memory. Before each API call, check `expires_at <= now` and re-fetch if expired. No background refresh needed.

#### Obtaining the OAuth token for Copilot provider

Sources to check (in priority order):
1. Previously cached token (in-memory or on disk)
2. `$GITHUB_TOKEN` environment variable (GitHub Codespaces only)
3. Copilot config files: `~/.config/github-copilot/hosts.json` or `apps.json`
   - Look for keys containing `github.com` with an `oauth_token` field
4. GitHub CLI: `gh auth token -h github.com`
5. Device flow (interactive, last resort)

### GitHub Models provider: single-layer token

The GitHub Models provider is simpler -- no session token exchange. The OAuth/PAT token is sent directly:

```
Bearer <gh_token> -> directly to models.github.ai
```

The token never expires (no `expires_at` -- it's a direct PAT/OAuth token, not a session token).

Token sources (in priority order):
1. Previously cached token
2. `$GITHUB_TOKEN` environment variable (Codespaces only)
3. GitHub CLI: `gh auth token -h github.com`
4. Device flow with client ID `178c6fc778ccc68e1d6a`, scope `read:user copilot`

> Note: The reference implementation (CopilotChat.nvim) has a bug where the `gh` CLI check is inverted -- it tries to run `gh` when the executable is NOT found. Your implementation should check that `gh` is available before attempting to call it.

### Device flow authentication

When no cached token exists, use OAuth device flow:

**Step 1: Request device code**
```
POST https://github.com/login/device/code
Headers: { "Accept": "application/json" }
Body (form-encoded): { "client_id": "<client_id>", "scope": "<scope>" }
```

> Note: The device flow endpoints use **form-encoded request bodies** with `Accept: application/json` for JSON responses. Do not send `Content-Type: application/json` to these endpoints.

Known client IDs:
- Copilot provider: `Iv1.b507a08c87ecfe98` (empty scope)
- GitHub Models provider: `178c6fc778ccc68e1d6a` (scope: `read:user copilot`)

Response:
```json
{
  "device_code": "3584d83530557fdd1f46af8289938c8ef79f9dc5",
  "user_code": "WDJB-MJHT",
  "verification_uri": "https://github.com/login/device",
  "expires_in": 900,
  "interval": 5
}
```

Key fields:
- `device_code` -- 40 characters, used in polling step
- `user_code` -- 8 characters with hyphen (e.g. `WDJB-MJHT`), shown to user
- `expires_in` -- seconds until codes expire (default 900 = 15 minutes). Request new codes if expired.
- `interval` -- minimum seconds between poll requests

**Step 2: Display to user**
Tell the user to visit `verification_uri` and enter `user_code`. User verification code submissions are limited to 50 per hour per application.

**Step 3: Poll for token**
```
POST https://github.com/login/oauth/access_token
Headers: { "Accept": "application/json" }
Body (form-encoded): {
  "client_id": "<client_id>",
  "device_code": "<device_code>",
  "grant_type": "urn:ietf:params:oauth:grant-type:device_code"
}
```

Poll every `interval` seconds. `client_secret` is NOT required for device flow.

Response on success:
```json
{
  "access_token": "gho_16C7e42F292c6912E7710c838347Ae178B4a",
  "token_type": "bearer",
  "scope": "repo,gist"
}
```

**All possible polling error codes:**

| Error | Action |
|-------|--------|
| `authorization_pending` | Continue polling (user hasn't authorized yet) |
| `slow_down` | **Add 5 seconds** to polling interval. New interval included in response. |
| `expired_token` | Device code expired (15 min). Restart from Step 1. |
| `access_denied` | User canceled authorization. Cannot reuse code. Terminal. |
| `unsupported_grant_type` | `grant_type` must be exactly `urn:ietf:params:oauth:grant-type:device_code` |
| `incorrect_client_credentials` | Wrong `client_id`. |
| `incorrect_device_code` | Invalid `device_code`. |
| `device_flow_disabled` | Device flow not enabled in app settings. |

Cache the token persistently -- it's long-lived.

---

## Required Request Headers

Every request to `api.githubcopilot.com` must include:

```
Authorization: Bearer <session_token>
Editor-Version: <editor>/<version>          (e.g. "Neovim/0.10.0", "VSCode/1.85.0")
Editor-Plugin-Version: <plugin>/<version>   (e.g. "MyCopilotClient/1.0")
Copilot-Integration-Id: vscode-chat
x-github-api-version: 2025-10-01
Content-Type: application/json              (for POST requests)
```

Additional conditional header:
- `x-initiator: agent` -- set when the request contains tool call results (i.e. the last message has `role: "tool"`)

For GitHub endpoints (`api.github.com`, `github.com`):
- `Accept: application/json` -- required for device flow and token exchange to get JSON responses instead of URL-encoded

---

## Listing Models

```
GET https://api.githubcopilot.com/models
Authorization: Bearer <session_token>
```

Response shape:
```json
{
  "data": [
    {
      "id": "gpt-4.1",
      "name": "GPT 4.1",
      "version": 1,
      "model_picker_enabled": true,
      "capabilities": {
        "type": "chat",
        "tokenizer": "o200k_base",
        "limits": {
          "max_prompt_tokens": 128000,
          "max_output_tokens": 16384
        },
        "supports": {
          "streaming": true,
          "tool_calls": true
        }
      },
      "supported_endpoints": ["/chat/completions", "/responses"],
      "policy": { "state": "enabled" }
    }
  ]
}
```

Key fields:
- Filter to `capabilities.type == "chat"` and `model_picker_enabled == true`
- `capabilities.tokenizer` -- needed for token counting (e.g. `o200k_base`, `cl100k_base`)
- `capabilities.supports.streaming` -- whether the model supports streaming responses
- `capabilities.supports.tool_calls` -- whether the model supports tool/function calling
- `supported_endpoints` -- determines which API format to use (see below)
- `policy` -- if the `policy` field is present and `policy.state` is NOT `"enabled"`, auto-enable via `POST /models/{id}/policy` with body `{"state": "enabled"}`. If the `policy` field is absent entirely, the model is considered enabled (no action needed).
- When duplicate `name` values exist, keep only the highest `version`

### GitHub Models provider: model listing differences

```
GET https://models.github.ai/catalog/models
Authorization: Bearer <gh_token>
```

The response is a **bare JSON array** (not wrapped in `{"data": [...]}` like copilot):
```json
[
  {
    "id": "gpt-4o",
    "name": "GPT-4o",
    "version": 1,
    "limits": {
      "max_input_tokens": 128000,
      "max_output_tokens": 16384
    },
    "capabilities": ["streaming", "tool-calling", "reasoning"]
  }
]
```

Key differences from copilot provider:
- `capabilities` is a **string array** (e.g. `["streaming", "tool-calling"]`), not a structured object. Check with `contains("streaming")`, `contains("tool-calling")`, `contains("reasoning")`.
- No `tokenizer` field -- defaults to `o200k_base` as a fallback. Token counts may be slightly inaccurate for models that use a different encoding.
- No `model_picker_enabled` or `policy` fields -- all returned models are available.
- No `supported_endpoints` -- always uses Chat Completions API.
- `limits` uses `max_input_tokens` / `max_output_tokens` (not nested under `capabilities`).

### Auto model selection

```
POST https://api.githubcopilot.com/models/session
Authorization: Bearer <session_token>
Content-Type: application/json

{"auto_mode": {"model_hints": ["auto"]}}
```

Response:
```json
{ "selected_model": "gpt-4.1" }
```

Cache model lists with a ~5 minute TTL to avoid excessive API calls.

---

## Quota / Usage Info

```
GET https://api.github.com/copilot_internal/user
Authorization: Token <oauth_token>
```

Response contains `quota_snapshots` with usage data:
```json
{
  "quota_snapshots": {
    "premium_interactions": {
      "entitlement": 300,
      "remaining": 250,
      "unlimited": false,
      "overage_permitted": false
    },
    "chat": { ... },
    "completions": { ... }
  },
  "quota_reset_date": "2025-04-01"
}
```

---

## Sending Chat Requests

### Which API format to use?

Per-model decision based on `supported_endpoints` from the `/models` response:
- Contains `"/responses"` -> use Responses API (`POST /responses`)
- Otherwise -> use Chat Completions API (`POST /chat/completions`)

### Chat Completions API

```
POST https://api.githubcopilot.com/chat/completions
Content-Type: application/json
Authorization: Bearer <session_token>
```

```json
{
  "model": "gpt-4.1",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "Explain this code..." },
    { "role": "assistant", "content": "This code does..." },
    { "role": "user", "content": "Can you refactor it?" }
  ],
  "stream": true,
  "n": 1,
  "top_p": 1,
  "temperature": 0.1,
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "read_file",
        "description": "Read a file from disk",
        "parameters": { "type": "object", "properties": { "path": { "type": "string" } } }
      }
    }
  ],
  "max_tokens": 16384
}
```

Field notes:
- `stream` -- set based on `capabilities.supports.streaming` from the model. Defaults to `false` if not supported.
- `max_tokens` -- set to `capabilities.limits.max_output_tokens` from the `/models` response. Omit if model doesn't report it.
- `tools` -- only include if the model has `capabilities.supports.tool_calls == true`
- **o1 models** (id starts with `o1`): demote `role: "system"` to `role: "user"` (o1 doesn't support system role), and omit `temperature`, `n`, `top_p`

### Responses API

```
POST https://api.githubcopilot.com/responses
Content-Type: application/json
Authorization: Bearer <session_token>
```

```json
{
  "model": "gpt-4.1",
  "stream": true,
  "instructions": "You are a helpful assistant.",
  "input": [
    { "role": "user", "content": "Explain this code..." },
    { "role": "assistant", "content": "This code does..." },
    { "role": "user", "content": "Can you refactor it?" }
  ],
  "tools": [
    {
      "type": "function",
      "name": "read_file",
      "description": "Read a file from disk",
      "parameters": { "type": "object", "properties": { "path": { "type": "string" } } }
    }
  ]
}
```

Field notes:
- `stream` -- defaults to `true` unless model explicitly sets `streaming: false`
- `instructions` -- system prompt goes here, NOT in the `input` array. If multiple system messages exist, concatenate them with `\n\n`
- `input` -- the messages array (no system messages in here)
- Tool definition is flatter than Chat Completions (no nested `function` wrapper)

### Key differences between the two APIs

| Aspect | Chat Completions | Responses API |
|--------|-----------------|---------------|
| System prompt | `role: "system"` in `messages` | `instructions` field |
| Messages field | `messages` | `input` |
| Stream default | `false` (opt-in) | `true` (opt-out) |
| Tool definition | Nested under `function` key | Flat |
| Tool call format | `role: "assistant"` with `tool_calls` | `type: "function_call"` items |
| Tool result format | `role: "tool"` | `type: "function_call_output"` |
| o1 handling | Manual system->user demotion | N/A (uses instructions field) |

---

## Streaming Responses

Both APIs support SSE (Server-Sent Events) streaming.

### Chat Completions streaming

```
data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}
data: {"choices":[{"delta":{"content":" world"},"finish_reason":null}]}
data: {"choices":[{"finish_reason":"stop"}],"usage":{"total_tokens":150},"model":"gpt-4.1"}
data: [DONE]
```

Key fields per chunk:
- `choices[0].delta.content` -- text content delta
- `choices[0].delta.reasoning` or `choices[0].delta.reasoning_content` -- reasoning output (see Reasoning section)
- `choices[0].delta.tool_calls` -- tool call deltas (see Tool Call Streaming section)
- `choices[0].finish_reason` or `choices[0].done_reason` -- `null` while streaming, `"stop"` when done, `"tool_calls"` when tools requested. Check both field names as some providers may use `done_reason`.
- `usage.total_tokens` -- present in final chunk (may be at `choices[0].usage.total_tokens` or top-level `usage.total_tokens`)
- `model` -- actual model used (may differ from requested if auto-selected). Can be at top-level or per-choice.

### Responses API streaming

Events have a `type` field:

```
data: {"type":"response.output_text.delta","delta":"Hello"}
data: {"type":"response.output_text.delta","delta":" world"}
data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"...","name":"...","arguments":"..."}}
data: {"type":"response.completed","response":{"status":"completed","usage":{"total_tokens":150},"model":"gpt-4.1","reasoning":{"summary":"..."}}}
```

Event types:
- `response.output_text.delta` -- text chunk (`delta` field, can be string or `{"text": "..."}`)
- `response.output_item.done` -- complete output item (including tool calls)
- `response.completed` / `response.done` -- final event with usage, model, reasoning summary
- `response.failed` -- error event with `error.message`

### Stream termination

- Chat Completions: stream ends with `data: [DONE]`
- Both: `finish_reason` of `"stop"` or `"tool_calls"` signals logical end
- Any `finish_reason` other than `"stop"` or `"tool_calls"` should be treated as an error/early termination

---

## Non-Streaming Responses

When `stream: false` (or streaming not supported), the response is a single JSON body.

### Chat Completions non-streaming

```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "Here is the explanation...",
        "reasoning": "Let me think about this...",
        "tool_calls": null
      },
      "finish_reason": "stop"
    }
  ],
  "usage": { "total_tokens": 150 },
  "model": "gpt-4.1"
}
```

Key difference from streaming: use `choices[0].message` (not `.delta`). Also check `finish_reason` or `done_reason` -- both field names may appear depending on the provider.

### Responses API non-streaming

```json
{
  "response": {
    "status": "completed",
    "output": [
      {
        "role": "assistant",
        "content": [
          { "type": "output_text", "text": "Here is the explanation..." }
        ]
      }
    ],
    "usage": { "total_tokens": 150 },
    "model": "gpt-4.1",
    "reasoning": { "summary": "Let me think about this..." }
  }
}
```

Key differences:
- Content is in `response.output[].content[]` as typed parts (extract `type == "output_text"` or `"text"` or `"input_text"`)
- Tool calls appear as items in `response.output[]` with `type: "function_call"`
- Status check: `response.status == "completed"` means success

---

## Reasoning Model Output

Some models support "reasoning" or "thinking" -- an internal chain-of-thought that's exposed separately from the main content.

### Chat Completions

Reasoning appears in:
- **Streaming**: `choices[0].delta.reasoning` or `choices[0].delta.reasoning_content`
- **Non-streaming**: `choices[0].message.reasoning` or `choices[0].message.reasoning_content`

Both field names should be checked -- different models may use either.

### Responses API

Reasoning appears in the final event/response:
- `response.reasoning.summary` -- a summary of the model's reasoning

### Usage notes

- Reasoning content is separate from `content` -- accumulate them in separate buffers
- The `/models` response indicates reasoning support via `capabilities` (for GitHub Models provider, check for `"reasoning"` in the capabilities array)
- Reasoning output is informational -- the actual answer is in `content`

---

## Tool Calling

### How it works (protocol level)

The tool calling loop is a multi-round conversation. The API does not execute tools -- it requests them, and your client executes and sends results back.

```
Round 1:
  Client -> API:  { messages/input: [...], tools: [...] }
  API -> Client:  finish_reason: "tool_calls"
                  tool_calls: [
                    { id: "call_abc", name: "read_file", arguments: '{"path":"/foo.py"}' },
                    { id: "call_def", name: "list_dir",  arguments: '{"path":"/src"}' }
                  ]

  Your client executes both tools locally and collects results.

Round 2:
  Client -> API:  { messages/input: [
                      ...all previous messages...,
                      <assistant message with tool_calls>,
                      <tool result for call_abc>,
                      <tool result for call_def>
                  ]}
  Headers: include x-initiator: agent
  API -> Client:  finish_reason: "stop", content: "Here's what I found..."
                  (or another round of tool_calls)
```

Key points:
- **Multiple tool calls per response** -- the model can request several tools at once. Each needs a corresponding result message.
- Each round is a **separate HTTP request** with full message history replayed
- The loop can repeat multiple rounds (model may chain tool calls)
- You decide how to orchestrate (auto-execute, ask user, skip, etc.)
- Skipping a tool call: still send a result message, but with an explanation as content (e.g. "Tool call was skipped")

### Chat Completions format for tool messages

Assistant requesting tool calls (include this in history for next request):
```json
{
  "role": "assistant",
  "content": null,
  "tool_calls": [
    {
      "id": "call_abc",
      "type": "function",
      "function": { "name": "read_file", "arguments": "{\"path\":\"/foo.py\"}" }
    },
    {
      "id": "call_def",
      "type": "function",
      "function": { "name": "list_dir", "arguments": "{\"path\":\"/src\"}" }
    }
  ]
}
```

Client sending tool results (one per tool call):
```json
{ "role": "tool", "tool_call_id": "call_abc", "content": "def hello():\n    print('hello')" }
{ "role": "tool", "tool_call_id": "call_def", "content": "main.py\nutils.py\nconfig.py" }
```

### Responses API format for tool messages

Tool calls appear as separate items in the `input` array:
```json
{ "type": "function_call", "call_id": "call_abc", "name": "read_file", "arguments": "{\"path\":\"/foo.py\"}" }
{ "type": "function_call", "call_id": "call_def", "name": "list_dir", "arguments": "{\"path\":\"/src\"}" }
```

Tool results:
```json
{ "type": "function_call_output", "call_id": "call_abc", "output": "def hello():\n    print('hello')" }
{ "type": "function_call_output", "call_id": "call_def", "output": "main.py\nutils.py\nconfig.py" }
```

### Tool call streaming (Chat Completions)

In streaming mode, tool calls arrive incrementally across multiple chunks. Each chunk contains partial data with an `index` field to identify which tool call it belongs to:

```
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","function":{"name":"read_file","arguments":""}}]}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"pa"}}]}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\":\"/foo.py\"}"}}]}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_def","function":{"name":"list_dir","arguments":""}}]}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{\"path\":\"/src\"}"}}]}}]}
data: {"choices":[{"finish_reason":"tool_calls"}]}
```

Accumulation logic:
- Use `index` as the key to track each tool call
- `id` and `name` arrive in the first chunk for that index
- `arguments` is streamed across multiple chunks -- **concatenate** all fragments for the same index
- When `finish_reason: "tool_calls"` arrives, all tool calls are complete

In Responses API streaming, tool calls arrive as complete items via `response.output_item.done` -- no incremental accumulation needed.

---

## Error Handling

### 401 with authorize_url

Some models require explicit user authorization. A 401 response may include:
```json
{
  "authorize_url": "https://github.com/...",
  "slug": "model-name"
}
```

The user must visit `authorize_url` to enable the model, then retry the request.

### General errors

- Non-2xx status codes indicate failure. The response body typically contains an error message as a string.
- Streaming errors:
  - Chat Completions: any `finish_reason` other than `"stop"`, `"tool_calls"`, or `null` is abnormal
  - Responses API: `response.failed` event with `error.message` field
- A streaming response that returns no content and no `[DONE]` marker should be treated as a failure -- fall back to parsing `response.body` line-by-line as a recovery attempt.

### Rate limiting and retries

Recommended HTTP defaults (based on what works in practice):
- 2 automatic retries with 1 second delay between retries
- 10 second connect timeout, 30 second overall timeout
- TCP keepalive at 60 seconds
- Disable response buffering for streaming (no-buffer)

**GitHub API rate limit headers** (returned on all responses):
```
x-ratelimit-limit: 5000          -- max requests per hour
x-ratelimit-remaining: 4999      -- requests left in window
x-ratelimit-used: 1              -- requests consumed
x-ratelimit-reset: 1711234567    -- UTC epoch when window resets
x-ratelimit-resource: core       -- which limit category was applied
```

**Rate-limited responses:**
- **403** or **429** status code when limit exceeded
- Check `retry-after` header for seconds to wait, or `x-ratelimit-reset` for when the window resets
- **Warning**: continuing to make requests while rate-limited may result in your integration being banned

**Retryable error codes:**
- **429 Too Many Requests** -- rate limited
- **502, 503, 504** -- server-side transient errors

**Secondary rate limits** (abuse prevention, per GitHub docs):
- No more than 100 concurrent requests
- No more than 900 points per minute on REST endpoints
- No more than 90 seconds CPU time per 60 seconds real time
- No more than 80 content-generating requests per minute

Recommended retry strategy:
- Retry on 429, 502, 503, 504
- Honor `retry-after` header if present; otherwise wait until `x-ratelimit-reset`
- Exponential backoff with jitter: `min(max_backoff, base * 2^attempt) * random(0.5, 1.5)`
- Cap total retry time (e.g. 120 seconds)

> Note: The Copilot-specific endpoints (`api.githubcopilot.com`) may have different rate limits than the general GitHub API. The headers above are documented for `api.github.com` -- the Copilot chat endpoints do not have published rate limits as of this writing. To discover them empirically, inspect `x-ratelimit-*` and `retry-after` headers in responses from `api.githubcopilot.com`. The reference implementation handles retries at the HTTP transport layer only -- your client should implement application-level backoff.

---

## Context Assembly & Token Budget

### Message ordering

When building the request, messages should be ordered:

```
1. System prompt          (role: "system", or "instructions" field for Responses API)
2. Context/resource data  (role: "user" -- file contents, code snippets, etc.)
3. Conversation history   (role: "user"/"assistant"/"tool" alternating)
```

### Formatting context data

Code and file content can be formatted as markdown code blocks with metadata:

```markdown
# file:///path/to/file.py
` ` `python path=/path/to/file.py start_line=1 end_line=50
 1: def hello():
 2:     print("hello")
` ` `
```

Each context block is sent as a separate `role: "user"` message. Line numbers in the content help the model reference specific lines in its response.

### Token budget algorithm

Each model reports `max_prompt_tokens` (via `/models` as `capabilities.limits.max_prompt_tokens`). Use the model's tokenizer to count tokens and fit content within the budget:

```
required_tokens = count(system_prompt) + count(current_user_prompt) + count(first_context_block)
history_budget  = max_prompt_tokens - required_tokens

1. Count total tokens across all history messages
2. While history_tokens > history_budget AND history has more than 1 message:
     Remove the oldest message (FIFO eviction)
     (Never remove the current/last user prompt)
3. remaining_budget = max_prompt_tokens - required_tokens - history_tokens
4. Add context blocks one by one until budget is exhausted
     If a block doesn't fit, stop adding (greedy fill)
```

Priority: current prompt > system prompt > recent history > context blocks > older history.

---

## System Prompt Composition

The system prompt is typically assembled from multiple layers:

```
1. Base instruction    (e.g. "You are a coding assistant")
2. Custom instructions (project-level files like .github/copilot-instructions.md)
3. Environment context (describe the editor/tool, how context data is formatted)
4. Tool instructions   (how the model should request tool calls)
5. Output format       (e.g. diff format preferences)
6. Variable substitution: {OS_NAME}, {LANGUAGE}, {DIR} etc.
```

For the Responses API, if your prompt composition produces multiple system-level strings, concatenate them with `\n\n` into the single `instructions` field.

---

## How Token Counting Works (BPE)

### What are tokens?

LLMs process **tokens**, not raw text. Tokens are integer IDs from a fixed vocabulary. A model's context window (e.g. 128k) is measured in tokens. One token is roughly ~4 characters of English on average, but varies:

- `"hello"` -> 1 token
- `"unconstitutional"` -> 3-4 tokens
- `"  "` (whitespace) -> 1 token
- `"こんにちは"` -> 3-5 tokens (non-Latin scripts cost more)
- `"x = 42"` -> 3 tokens

### Byte Pair Encoding (BPE)

Token vocabularies are built using BPE, a compression algorithm:

**Training phase** (done once, you use the published result):
1. Start with a vocabulary of all 256 individual bytes
2. Scan a massive text corpus, find the most frequently adjacent pair of tokens
3. Merge that pair into a new single token, add to vocabulary
4. Repeat until vocabulary reaches target size (e.g. 200,000 for `o200k_base`)

This produces a **merge priority list**:
```
Merge #1:    "t" + "h"  ->  "th"       (most common pair)
Merge #2:    "th" + "e"  ->  "the"
Merge #3:    " " + "t"  ->  " t"
...
Merge #199744: "Hel" + "lo" -> "Hello"
```

**Encoding phase** (done at runtime to count tokens):
1. Convert input text to raw bytes
2. Split into chunks using a regex that separates words, whitespace, punctuation, numbers:
   ```
   letters+ | digits{1,3} | punctuation | whitespace{1,} | anything_else
   ```
   This prevents merges from crossing word/category boundaries.
3. For each chunk, apply BPE merges in priority order:
   - Find all adjacent pairs in the current sequence
   - Merge the highest-priority pair (lowest merge rank)
   - Repeat until no more merges possible
4. Map each resulting byte sequence to its vocabulary ID
5. Return the list of token IDs

**Example** for `"Hello world"`:
```
Regex split: ["Hello", " world"]

Chunk "Hello":
  [H][e][l][l][o]
  -> merge "l"+"l" -> [H][e][ll][o]
  -> merge "H"+"e" -> [He][ll][o]
  -> merge "He"+"ll" -> [Hell][o]
  -> merge "Hell"+"o" -> [Hello]
  -> token ID: 15339

Chunk " world":
  [ ][w][o][r][l][d]
  -> merge " "+"w" -> [ w][o][r][l][d]
  -> merge "o"+"r" -> [ w][or][l][d]
  -> merge "or"+"l" -> [ w][orl][d]
  -> merge " w"+"orl" -> [ worl][d]
  -> merge " worl"+"d" -> [ world]
  -> token ID: 1917

Result: [15339, 1917] -> 2 tokens
```

(Actual merge order may differ; this illustrates the principle.)

### Tokenizer encodings used by Copilot models

Each model reports its encoding via the `/models` response (`capabilities.tokenizer` field):

| Encoding | Vocab size | Used by |
|----------|-----------|---------|
| `o200k_base` | ~200k tokens | GPT-4o, GPT-4.1, most current models |
| `cl100k_base` | ~100k tokens | GPT-4, GPT-3.5-turbo, older models |

### The vocabulary file

Each encoding has a static data file (published by OpenAI) mapping byte sequences to token ranks. For `o200k_base` it's ~4MB of base64-encoded entries:

```
IQ==    0
Ig==    1
Iw==    2
...
SGVsbG8=  15339
...
```

Download once, cache locally, build a lookup table, and run BPE at runtime.

### Why exact counting matters

The ~4 chars/token estimate breaks down for:

- **Code**: operators, brackets, indentation -> more tokens per line than prose
- **Non-ASCII**: UTF-8 multibyte characters can cost 2-4x more
- **Repetitive text**: common patterns compress well, rare ones don't
- **Mixed content**: code + natural language + file paths has unpredictable density

When packing a context window to its limit, even a 10% estimation error means truncation or wasted capacity. Use the actual tokenizer for accurate counts.

---

## Subscription Tiers & Premium Requests

### Plans and quotas (from GitHub docs)

| Plan | Price | Premium requests/month | Chat messages |
|------|-------|----------------------|---------------|
| **Free** | $0 | 50 | 50/month |
| **Student** | $0 (verified) | 300 | Unlimited (included models) |
| **Pro** | $10/month | 300 | Unlimited (included models) |
| **Pro+** | $39/month | 1,500 | Unlimited (included models) |
| **Business** | $19/seat/month | 300/user | Unlimited (included models) |
| **Enterprise** | $39/seat/month | 1,000/user | Unlimited (included models) |

### What counts as a premium request

A premium request is any user-initiated interaction with Copilot using a non-included model. For agentic features, only the user-initiated prompt counts -- autonomous tool calls by the agent do NOT consume premium requests.

- Chat: 1 request per prompt
- CLI: 1 request per prompt
- Code review: 1 request per review
- Coding agent: 1 per session
- Spark: 4 per prompt (fixed)

### Model cost multipliers

Models have complexity-based multipliers that affect how many premium requests are consumed:

| Multiplier | Models |
|-----------|--------|
| **0x (included/free)** | GPT-5 mini, GPT-4.1, GPT-4o -- zero premium cost on paid plans |
| **0.33x (low cost)** | Claude Haiku 4.5, Gemini 3 Flash, GPT-5.1-Codex-Mini, GPT-5.4 mini |
| **1x (standard)** | Claude Sonnet variants, Gemini 3 Pro/3.1 Pro, GPT-5.1/5.2/5.3/5.4 |
| **3x (high cost)** | Claude Opus 4.5, Claude Opus 4.6 |
| **30x (extreme)** | Claude Opus 4.6 fast mode (Pro+ only, preview) |

### When quota is exhausted

- Unused requests do NOT carry over to the next month
- Paid subscribers can still use included models (0x multiplier) after exhaustion
- Response times may vary during high demand
- Additional requests require budget setup or plan upgrade

### Auto model selection helps with rate limits

The "auto" model option "selects the best model based on availability and to help reduce rate limiting" -- useful for staying within quota and avoiding 429s.

### Note on model list freshness

The model names and multipliers above are a **point-in-time snapshot** (March 2026). GitHub adds and removes models regularly. Do not hardcode these -- use the `/models` endpoint as the live source of truth for available models and the quota API (`/copilot_internal/user`) to check remaining premium requests at runtime. The multiplier tiers (0x, 0.33x, 1x, 3x, 30x) are more stable than the specific models in each tier.
