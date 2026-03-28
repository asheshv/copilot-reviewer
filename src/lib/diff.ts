// src/lib/diff.ts
import { execFile as execFileCallback } from "child_process";
import { promisify } from "util";
import { minimatch } from "minimatch";
import { DiffError, type DiffOptions, type DiffResult, type FileChange } from "./types.js";

const execFile = promisify(execFileCallback);

const DEFAULT_MAX_DIFF_SIZE = 10 * 1024 * 1024; // 10 MB

/**
 * Collects a diff based on the specified mode and options.
 *
 * @param options - Options for diff collection
 * @returns Parsed diff result with raw text, file changes, and stats
 * @throws DiffError for various error conditions
 */
export async function collectDiff(options: DiffOptions): Promise<DiffResult> {
  const { mode, base, pr, range, count, ignorePaths = [] } = options;

  // Build command and arguments
  let command: string;
  let args: string[];

  switch (mode) {
    case "unstaged":
      command = "git";
      args = ["diff"];
      break;

    case "staged":
      command = "git";
      args = ["diff", "--cached"];
      break;

    case "local":
      command = "git";
      args = ["diff", "HEAD"];
      break;

    case "branch":
      if (!base) {
        throw new DiffError("base_not_found", "base parameter required for branch mode", false);
      }
      if (base.startsWith("-")) {
        throw new DiffError("invalid_ref", `Invalid base branch: '${base}'. Branch names cannot start with '-'.`, false);
      }
      command = "git";
      args = ["diff", `${base}...HEAD`];
      break;

    case "pr":
      if (!pr) {
        throw new DiffError("pr_not_found", "pr parameter required for pr mode", false);
      }
      command = "gh";
      args = ["pr", "diff", String(pr), "--patch"];
      break;

    case "commits":
      if (!count || count <= 0) {
        throw new DiffError("invalid_ref", "count parameter required and must be positive for commits mode", false);
      }
      command = "git";
      args = ["diff", `HEAD~${count}..HEAD`];
      break;

    case "range":
      if (!range) {
        throw new DiffError("invalid_ref", "range parameter required for range mode", false);
      }
      if (range.startsWith("-")) {
        throw new DiffError("invalid_ref", `Invalid range: '${range}'. Range cannot start with '-'.`, false);
      }
      command = "git";
      args = ["diff", range];
      break;

    default:
      throw new DiffError("invalid_ref", `Unknown mode: ${mode}`, false);
  }

  // Execute command
  let stdout: string;
  let stderr: string;

  try {
    const result = await execFile(command, args);
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err: any) {
    // Handle command not found
    if (err.code === "ENOENT") {
      if (command === "git") {
        throw new DiffError("git_not_installed", "git is not installed or not in PATH. Install git: https://git-scm.com/", false, err);
      } else if (command === "gh") {
        throw new DiffError("gh_not_installed", "PR mode requires the GitHub CLI (gh). Install: https://cli.github.com/", false, err);
      } else {
        // Should never happen with current modes, but handle defensively
        throw new DiffError("git_not_installed", `Command not found: ${command}`, false, err);
      }
    }

    // If execFile threw, check stdout/stderr from error object
    stdout = err.stdout || "";
    stderr = err.stderr || "";
  }

  // Only check stderr for error patterns if command failed (non-zero exit)
  // Git writes warnings to stderr even on success — don't treat those as errors
  if (stderr && !stdout) {
    const stderrLower = stderr.toLowerCase();

    if (stderrLower.includes("not a git repository")) {
      throw new DiffError("not_git_repo", "Not inside a git repository. Run from a git project directory.", false);
    }

    if (stderrLower.includes("no pull requests found")) {
      throw new DiffError("pr_not_found", `Pull request #${pr} not found.`, false);
    }

    // Check for unknown revision errors
    if (stderrLower.includes("unknown revision")) {
      if (mode === "local" && stderrLower.includes("head")) {
        throw new DiffError("no_commits", "No commits in this repository yet. Make an initial commit before reviewing changes.", false);
      }

      if (mode === "commits" && stderrLower.includes(`head~${count}`)) {
        throw new DiffError(
          "insufficient_history",
          `Not enough commit history for \`commits ${count}\`. This may be a shallow clone. Fetch more history with \`git fetch --unshallow\`.`,
          false
        );
      }

      if (mode === "branch" && base && stderrLower.includes(base.toLowerCase())) {
        throw new DiffError("base_not_found", `Base branch '${base}' not found.`, false);
      }

      throw new DiffError("invalid_ref", `Reference not found. Check that both refs in the range exist. Git error: ${stderr.trim()}`, false);
    }
  }

  // Check if diff is empty
  if (!stdout || stdout.trim().length === 0) {
    const modeHint = mode === "staged" ? " Did you mean 'unstaged' or 'local'?" :
                     mode === "unstaged" ? " Did you mean 'staged' or 'local'?" : "";
    throw new DiffError("empty_diff", `No changes found for mode '${mode}'.${modeHint}`, false);
  }

  // Check size limit
  let maxSize = DEFAULT_MAX_DIFF_SIZE;
  if (process.env.COPILOT_REVIEW_MAX_DIFF_SIZE) {
    const parsed = parseInt(process.env.COPILOT_REVIEW_MAX_DIFF_SIZE, 10);
    if (!isNaN(parsed) && parsed > 0) {
      maxSize = parsed;
    }
  }

  if (stdout.length > maxSize) {
    throw new DiffError(
      "diff_too_large",
      `Diff is too large (${stdout.length} bytes, max ${maxSize} bytes). Use ignorePaths, a smaller diff mode, or increase COPILOT_REVIEW_MAX_DIFF_SIZE.`,
      false
    );
  }

  // Parse diff
  const { files, raw } = parseDiff(stdout, ignorePaths);

  // Check if all files were filtered out
  if (files.length === 0) {
    throw new DiffError("empty_diff", `No changes found after applying ignore patterns for mode '${mode}'.`, false);
  }

  // Calculate stats
  const stats = {
    filesChanged: files.length,
    insertions: files.reduce((sum, f) => sum + f.insertions, 0),
    deletions: files.reduce((sum, f) => sum + f.deletions, 0),
  };

  return { raw, files, stats };
}

/**
 * Parses a unified diff output into structured data.
 *
 * @param diffText - Raw diff text from git
 * @param ignorePaths - Glob patterns to filter out
 * @returns Parsed file changes and filtered raw diff
 */
function parseDiff(
  diffText: string,
  ignorePaths: string[]
): { files: FileChange[]; raw: string } {
  const files: FileChange[] = [];
  const sections: string[] = [];

  // Split by "diff --git" markers
  const diffSections = diffText.split(/(?=diff --git )/);

  for (const section of diffSections) {
    if (!section.trim()) continue;

    // Extract file paths from "diff --git a/... b/..." line
    const diffLine = section.match(/^diff --git a\/(.+?) b\/(.+?)$/m);
    if (!diffLine) continue;

    const pathA = diffLine[1];
    const pathB = diffLine[2];

    // Determine file status
    let status: FileChange["status"];
    let path: string;
    let oldPath: string | undefined;

    // Check for binary file
    const isBinary = /^Binary files .* differ$/m.test(section);

    if (section.includes("new file mode")) {
      status = "added";
      path = pathB;
    } else if (section.includes("deleted file mode")) {
      status = "deleted";
      path = pathA;
    } else if (section.includes("rename from") && section.includes("rename to")) {
      status = "renamed";
      const renameFrom = section.match(/^rename from (.+)$/m);
      const renameTo = section.match(/^rename to (.+)$/m);
      oldPath = renameFrom ? renameFrom[1] : pathA;
      path = renameTo ? renameTo[1] : pathB;
    } else {
      status = "modified";
      path = pathB;
    }

    // Count insertions and deletions (skip for binary files)
    let insertions = 0;
    let deletions = 0;

    if (!isBinary) {
      const lines = section.split("\n");
      for (const line of lines) {
        if (line.startsWith("+") && !line.startsWith("+++")) {
          insertions++;
        } else if (line.startsWith("-") && !line.startsWith("---")) {
          deletions++;
        }
      }
    }

    // Build file change object
    const fileChange: FileChange = {
      path,
      status,
      insertions,
      deletions,
    };

    if (oldPath) {
      fileChange.oldPath = oldPath;
    }

    // Check if path should be ignored
    const shouldIgnore = ignorePaths.some((pattern) => {
      return minimatch(path, pattern) || (oldPath && minimatch(oldPath, pattern));
    });

    if (!shouldIgnore) {
      files.push(fileChange);
      // Include all sections in raw (binary "Binary files ... differ" markers preserved per spec)
      sections.push(section);
    }
  }

  const raw = sections.join("");

  return { files, raw };
}
