# 05 — Model Management

[Back to Spec Index](./README.md) | Prev: [04 — Copilot Client](./04-copilot-client.md) | Next: [06 — Configuration](./06-configuration.md)

> API details: [Copilot API Reference — Models](../reference/copilot-api-reference.md)

---

## Model Listing

```
GET https://api.githubcopilot.com/models
Authorization: Bearer <session_token>
```

### Filtering

From the raw response, filter to usable models:

1. `capabilities.type == "chat"` — only chat-capable models
2. `model_picker_enabled == true` — only user-selectable models
3. Deduplicate by `name` — keep highest `version`

### Policy Auto-Enable

If a model has `policy.state` that is NOT `"enabled"`, auto-enable it:

```
POST https://api.githubcopilot.com/models/{id}/policy
Body: {"state": "enabled"}
```

If the `policy` field is absent entirely, the model is considered enabled (no action needed).

### Caching

Cache the model list in memory with **5 minute TTL (300 seconds)**. Invalidate on cache miss or after TTL expires. The MCP server benefits from this since it's long-lived.

> **Warning:** GitHub adds and removes models regularly. Never hardcode model IDs or capabilities. Always fetch from `/models` endpoint.

## Auto Selection

```
POST https://api.githubcopilot.com/models/session
Authorization: Bearer <session_token>
Content-Type: application/json

{"auto_mode": {"model_hints": ["auto"]}}
```

Response:
```json
{"selected_model": "gpt-4.1"}
```

Auto-selection helps with rate limits and picks the best available model based on current load.

## Model Validation

When the user provides `--model <id>`:

1. Fetch model list
2. Check if `id` exists in the list
3. If not found → `ModelError { code: "model_not_found", available: [...] }`

The error includes the list of valid model IDs so the user (or agent) can correct.

## Public Interface

```typescript
interface ModelInfo {
  id: string;
  name: string;
  endpoints: string[];        // e.g. ["/chat/completions", "/responses"]
  streaming: boolean;
  toolCalls: boolean;
  maxPromptTokens: number;
  maxOutputTokens: number;
  tokenizer: string;          // e.g. "o200k_base"
}

listModels(): Promise<ModelInfo[]>
autoSelect(): Promise<string>           // returns model ID
validateModel(id: string): Promise<ModelInfo>  // throws ModelError if not found
```

## CLI: `copilot-review models`

Lists available models in a human-readable table:

```
ID              Name          Context   Output    Streaming  Tools
gpt-4.1         GPT 4.1       128k      16k       yes        yes
gpt-4o          GPT-4o        128k      16k       yes        yes
claude-sonnet   Claude Sonnet  200k      8k        yes        yes
...
```

The [MCP server](./09-mcp-server.md) returns the same data as structured JSON via the `copilot_models` tool.

## Model Costs and Quotas

Models consume premium requests with different multipliers:

| Multiplier | Typical Models |
|-----------|----------------|
| 0x (free) | GPT-4.1, GPT-4o (on paid plans) |
| 0.33x | Claude Haiku, Gemini Flash |
| 1x | Claude Sonnet, Gemini Pro |
| 3x | Claude Opus |

> These are point-in-time examples. Use the `/copilot_internal/user` endpoint for live quota data.

### Quota Checking

```
GET https://api.github.com/copilot_internal/user
Authorization: Token <oauth_token>
```

Returns `quota_snapshots.premium_interactions.remaining` and `quota_reset_date`. The CLI `copilot-review models` command should display cost multiplier (if available from API). A dedicated `copilot-review quota` subcommand is a [future enhancement](./14-future.md).

## GitHub Models Provider (Alternative)

> Documented for awareness. v1 implements the Copilot provider only.

An alternative provider at `models.github.ai` offers simpler auth (direct PAT, no session token exchange) but fewer features:

| Aspect | Copilot Provider | GitHub Models Provider |
|--------|-----------------|----------------------|
| Endpoint | `api.githubcopilot.com` | `models.github.ai` |
| Auth | Two-layer (OAuth → session token) | Single-layer (direct PAT) |
| Model response | `{"data": [...]}` with nested capabilities object | Bare array with string capabilities |
| API formats | Chat Completions + Responses API | Chat Completions only |
| Policy management | Yes (`/models/{id}/policy`) | No |
| Tokenizer info | Yes (`capabilities.tokenizer`) | No (default `o200k_base`) |

See [Copilot API Reference](../reference/copilot-api-reference.md) for full protocol differences.
