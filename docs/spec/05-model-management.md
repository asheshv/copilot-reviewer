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

Cache the model list in memory with ~5 minute TTL to avoid excessive API calls. The MCP server benefits from this since it's long-lived.

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
