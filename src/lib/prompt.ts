// src/lib/prompt.ts
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import type { DiffResult } from "./types.js";

/**
 * Load the built-in default review prompt from prompts/default-review.md.
 * Uses import.meta.url to resolve the path relative to the package root.
 */
export function loadBuiltInPrompt(): string {
  // Get the directory of the current module
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = dirname(currentFile);

  // Navigate from src/lib to package root, then to prompts/
  const promptPath = join(currentDir, "..", "..", "prompts", "default-review.md");

  return readFileSync(promptPath, "utf-8");
}

/**
 * Assemble the user message from a diff result.
 * Formats the summary stats and includes the raw diff in a code block.
 */
export function assembleUserMessage(diff: DiffResult): string {
  const { stats, raw } = diff;

  const message = [
    "Please review the following code changes:",
    "",
    `**Files changed:** ${stats.filesChanged}`,
    `**Insertions:** ${stats.insertions}`,
    `**Deletions:** ${stats.deletions}`,
    "",
    "```diff",
    raw,
    "```",
  ].join("\n");

  return message;
}
