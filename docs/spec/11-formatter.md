# 11 — Formatter

[Back to Spec Index](./README.md) | Prev: [10 — Error Handling](./10-error-handling.md) | Next: [12 — Default Prompt](./12-default-prompt.md)

---

## Overview

`formatter.ts` wraps Copilot's review response in a thin presentation layer. It does NOT reformat or restructure Copilot's content — the review passes through as-is (or lightly stripped for text format).

## Public API

```typescript
format(result: ReviewResult, fmt: "text" | "markdown" | "json"): string
```

## Output Formats

### Markdown (default for terminal)

```markdown
# Copilot Code Review

**Model:** gpt-4.1 | **Files:** 5 | **+120 -45**

## Findings

<copilot's review content — passed through as-is>

---
*Tokens used: 1,234 | Model: gpt-4.1*
```

Thin header with metadata, Copilot's response verbatim, thin footer with usage.

### Text (plain, no markup)

```
Copilot Code Review
Model: gpt-4.1 | Files: 5 | +120 -45

<copilot's review content — markdown syntax stripped>

Tokens used: 1,234
```

Strips markdown syntax from Copilot's response:
- Headers → plain text lines
- Code fences → indented blocks
- Bold/italic → plain text

Useful for piping into tools that don't handle markdown (email, Slack webhooks, plain log files).

### JSON (machine-parseable)

```json
{
  "review": {
    "content": "<copilot's raw response>",
    "model": "gpt-4.1",
    "usage": { "totalTokens": 1234 }
  },
  "diff": {
    "filesChanged": 5,
    "insertions": 120,
    "deletions": 45,
    "files": [
      {
        "path": "src/auth.ts",
        "status": "modified",
        "insertions": 30,
        "deletions": 10
      }
    ]
  },
  "warnings": [],
  "exitCode": 0
}
```

Single parseable object containing everything — review, diff metadata, warnings, and exit code.

The JSON format intentionally differs from the internal `ReviewResult` type:
- It nests review fields under a `review` key for clearer structure
- It flattens `DiffResult.stats` into top-level `diff` fields for readability
- It adds `exitCode` — determined by regex-scanning the response content for `### HIGH` or `[HIGH]` patterns (see [10 — Error Handling](./10-error-handling.md) for details)

The `exitCode` field lets machine consumers get the severity signal without parsing the CLI's exit code.

## Warnings

Warnings (token budget exceeded, binary files skipped, etc.) appear in all formats:

| Format | Where warnings appear |
|--------|-----------------------|
| markdown | stderr (before review output) |
| text | stderr (before review output) |
| json | `warnings` array in the JSON object |

## Design Principle

The formatter is deliberately thin. Copilot's response is the product — the formatter just frames it. No interpretation, no restructuring, no severity extraction (that's a [future enhancement](./14-future.md)).
