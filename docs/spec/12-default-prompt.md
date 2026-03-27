# 12 — Default Review Prompt

[Back to Spec Index](./README.md) | Prev: [11 — Formatter](./11-formatter.md) | Next: [13 — Testing](./13-testing.md)

---

## Overview

The built-in review prompt ships at `prompts/default-review.md`. It is opinionated — tuned for thorough, security-first reviews with structured output.

This prompt is Layer 1 in the [configuration hierarchy](./06-configuration.md). It is always present unless explicitly replaced.

## Priority Order

1. **Security** (non-negotiable)
   - SQL injection, XSS, command injection, path traversal
   - Auth bypass, insecure defaults, secrets in code
   - OWASP Top 10 reflexively

2. **Correctness**
   - Edge cases: NULL, empty, zero, negative, boundary, off-by-one
   - Race conditions, error paths, resource cleanup
   - Assumptions that may not hold

3. **Performance**
   - N+1 queries, missing indexes, unnecessary allocations
   - Quadratic loops, set-based vs row-by-row
   - Algorithmic complexity

4. **Readability**
   - Unclear naming, misleading comments
   - Unnecessary complexity

5. **Simplicity**
   - Over-engineering, premature abstractions
   - YAGNI violations

## Output Format

Each finding uses ONE severity level as the header prefix. Examples:

```markdown
### HIGH SQL injection in query builder
### MEDIUM Missing null check on user input
### LOW Variable name is misleading
```

Full template per finding:

```markdown
### HIGH <title>
**File:** `path/to/file.ts` **Line:** <line or range>
**Category:** Security | Correctness | Performance | Readability | Simplicity

<description of the issue>

**Suggestion:**
```<lang>
<suggested fix if applicable>
```
```

This format is:
- **Human-scannable** — severity + file + line at a glance
- **Machine-parseable** — structured enough for future extraction into JSON findings
- **Actionable** — suggestions with code, not just complaints

## Rules

- Flag security issues as **HIGH** even if exploitation seems unlikely.
- Every code path deserves scrutiny, not just the happy path.
- If unsure about severity, err on the side of flagging.
- If no issues found, say so explicitly — **don't invent findings**.
- End with a brief summary: total findings by severity, overall assessment.

## "Don't Invent Findings" Rule

LLMs tend to hallucinate issues when prompted to find them. The explicit instruction to say "no issues found" rather than fabricate is deliberate and important. A false positive wastes the reviewer's time and erodes trust in the tool.

## Customization

See [06 — Configuration](./06-configuration.md) for how to extend or replace this prompt at the global or project level.
