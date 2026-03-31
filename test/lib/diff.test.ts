// test/lib/diff.test.ts
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "child_process";
import { readFile } from "fs/promises";
import { collectDiff } from "../../src/lib/diff.js";
import { DiffError } from "../../src/lib/types.js";

// Mock child_process
vi.mock("child_process", () => ({ execFile: vi.fn() }));

const mockExecFile = vi.mocked(execFile);

// Store original env
let originalEnv: typeof process.env;

beforeEach(() => {
  vi.resetAllMocks();
  originalEnv = process.env;
  process.env = { ...originalEnv };
  delete process.env.LLM_REVIEWER_MAX_DIFF_SIZE;
});

afterEach(() => {
  process.env = originalEnv;
});

// Helper to load fixture
async function loadFixture(name: string): Promise<string> {
  const path = new URL(`../fixtures/diffs/${name}`, import.meta.url);
  return readFile(path, "utf-8");
}

describe("collectDiff", () => {
  describe("mode to command mapping", () => {
    it("unstaged -> git diff", async () => {
      mockExecFile.mockImplementation((cmd, args, callback: any) => {
        expect(cmd).toBe("git");
        expect(args).toEqual(["diff"]);
        callback(null, { stdout: "", stderr: "" });
      });

      await expect(collectDiff({ mode: "unstaged" })).rejects.toThrow(DiffError);
      await expect(collectDiff({ mode: "unstaged" })).rejects.toMatchObject({
        code: "empty_diff",
      });
    });

    it("staged -> git diff --cached", async () => {
      mockExecFile.mockImplementation((cmd, args, callback: any) => {
        expect(cmd).toBe("git");
        expect(args).toEqual(["diff", "--cached"]);
        callback(null, { stdout: "", stderr: "" });
      });

      await expect(collectDiff({ mode: "staged" })).rejects.toThrow(DiffError);
      await expect(collectDiff({ mode: "staged" })).rejects.toMatchObject({
        code: "empty_diff",
      });
    });

    it("local -> git diff HEAD", async () => {
      mockExecFile.mockImplementation((cmd, args, callback: any) => {
        expect(cmd).toBe("git");
        expect(args).toEqual(["diff", "HEAD"]);
        callback(null, { stdout: "", stderr: "" });
      });

      await expect(collectDiff({ mode: "local" })).rejects.toThrow(DiffError);
    });

    it("branch -> git diff <base>...HEAD", async () => {
      mockExecFile.mockImplementation((cmd, args, callback: any) => {
        expect(cmd).toBe("git");
        expect(args).toEqual(["diff", "main...HEAD"]);
        callback(null, { stdout: "", stderr: "" });
      });

      await expect(collectDiff({ mode: "branch", base: "main" })).rejects.toThrow(DiffError);
    });

    it("pr -> gh pr diff <number> --patch", async () => {
      mockExecFile.mockImplementation((cmd, args, callback: any) => {
        expect(cmd).toBe("gh");
        expect(args).toEqual(["pr", "diff", "123", "--patch"]);
        callback(null, { stdout: "", stderr: "" });
      });

      await expect(collectDiff({ mode: "pr", pr: 123 })).rejects.toThrow(DiffError);
    });

    it("commits -> git diff HEAD~<n>..HEAD", async () => {
      mockExecFile.mockImplementation((cmd, args, callback: any) => {
        expect(cmd).toBe("git");
        expect(args).toEqual(["diff", "HEAD~3..HEAD"]);
        callback(null, { stdout: "", stderr: "" });
      });

      await expect(collectDiff({ mode: "commits", count: 3 })).rejects.toThrow(DiffError);
    });

    it("range -> git diff <ref1>..<ref2>", async () => {
      mockExecFile.mockImplementation((cmd, args, callback: any) => {
        expect(cmd).toBe("git");
        expect(args).toEqual(["diff", "v1.0..v2.0"]);
        callback(null, { stdout: "", stderr: "" });
      });

      await expect(collectDiff({ mode: "range", range: "v1.0..v2.0" })).rejects.toThrow(DiffError);
    });
  });

  describe("result parsing", () => {
    it("extracts raw diff text", async () => {
      const fixture = await loadFixture("simple-modify.diff");
      mockExecFile.mockImplementation((cmd, args, callback: any) => {
        callback(null, { stdout: fixture, stderr: "" });
      });

      const result = await collectDiff({ mode: "unstaged" });
      expect(result.raw).toBe(fixture);
    });

    it("parses file list with status and stats", async () => {
      const fixture = await loadFixture("multi-file.diff");
      mockExecFile.mockImplementation((cmd, args, callback: any) => {
        callback(null, { stdout: fixture, stderr: "" });
      });

      const result = await collectDiff({ mode: "unstaged" });
      expect(result.files).toHaveLength(3);

      // New file
      expect(result.files[0]).toMatchObject({
        path: "src/new.ts",
        status: "added",
        insertions: 4,
        deletions: 0,
      });

      // Modified file
      expect(result.files[1]).toMatchObject({
        path: "src/app.ts",
        status: "modified",
        insertions: 6,
        deletions: 1,
      });

      // Deleted file
      expect(result.files[2]).toMatchObject({
        path: "src/removed.ts",
        status: "deleted",
        insertions: 0,
        deletions: 3,
      });

      // Stats
      expect(result.stats).toEqual({
        filesChanged: 3,
        insertions: 10,
        deletions: 4,
      });
    });

    it("detects binary files in metadata, excludes from raw", async () => {
      const fixture = await loadFixture("binary.diff");
      mockExecFile.mockImplementation((cmd, args, callback: any) => {
        callback(null, { stdout: fixture, stderr: "" });
      });

      const result = await collectDiff({ mode: "unstaged" });

      // Binary file should be in files list but excluded from raw
      expect(result.files).toHaveLength(2);
      expect(result.files[0]).toMatchObject({
        path: "assets/logo.png",
        status: "modified",
        insertions: 0,
        deletions: 0,
      });

      expect(result.files[1]).toMatchObject({
        path: "src/app.ts",
        status: "modified",
      });

      // Binary file markers preserved in raw per spec
      expect(result.raw).toContain("Binary files");
      expect(result.raw).toContain("src/app.ts");
    });

    it("captures renamed files with oldPath and path", async () => {
      const fixture = await loadFixture("rename.diff");
      mockExecFile.mockImplementation((cmd, args, callback: any) => {
        callback(null, { stdout: fixture, stderr: "" });
      });

      const result = await collectDiff({ mode: "unstaged" });
      expect(result.files).toHaveLength(1);
      expect(result.files[0]).toMatchObject({
        path: "src/new-name.ts",
        oldPath: "src/old-name.ts",
        status: "renamed",
        insertions: 2,
        deletions: 1,
      });
    });
  });

  describe("ignorePaths filtering", () => {
    it("excludes matched files from raw and files metadata", async () => {
      const fixture = await loadFixture("multi-file.diff");
      mockExecFile.mockImplementation((cmd, args, callback: any) => {
        callback(null, { stdout: fixture, stderr: "" });
      });

      const result = await collectDiff({
        mode: "unstaged",
        ignorePaths: ["src/new.ts", "src/removed.ts"],
      });

      expect(result.files).toHaveLength(1);
      expect(result.files[0].path).toBe("src/app.ts");

      // Raw should not contain ignored files
      expect(result.raw).not.toContain("src/new.ts");
      expect(result.raw).not.toContain("src/removed.ts");
      expect(result.raw).toContain("src/app.ts");
    });

    it("updates stats after filtering", async () => {
      const fixture = await loadFixture("multi-file.diff");
      mockExecFile.mockImplementation((cmd, args, callback: any) => {
        callback(null, { stdout: fixture, stderr: "" });
      });

      const result = await collectDiff({
        mode: "unstaged",
        ignorePaths: ["src/new.ts"],
      });

      expect(result.stats).toEqual({
        filesChanged: 2,
        insertions: 6,
        deletions: 4,
      });
    });

    it("handles glob patterns (e.g., *.lock, vendor/**)", async () => {
      const fixture = await loadFixture("multi-file.diff");
      mockExecFile.mockImplementation((cmd, args, callback: any) => {
        callback(null, { stdout: fixture, stderr: "" });
      });

      // When all files are filtered out, throws empty_diff
      await expect(
        collectDiff({ mode: "unstaged", ignorePaths: ["src/*.ts"] })
      ).rejects.toMatchObject({ code: "empty_diff" });
    });
  });

  describe("validations and errors", () => {
    it("throws git_not_installed when git binary not found", async () => {
      mockExecFile.mockImplementation((cmd, args, callback: any) => {
        const error = new Error("Command failed") as any;
        error.code = "ENOENT";
        callback(error, { stdout: "", stderr: "" });
      });

      await expect(collectDiff({ mode: "unstaged" })).rejects.toMatchObject({
        name: "DiffError",
        code: "git_not_installed",
      });
    });

    it("throws not_git_repo when not inside git repo", async () => {
      mockExecFile.mockImplementation((cmd, args, callback: any) => {
        callback(null, {
          stdout: "",
          stderr: "fatal: not a git repository (or any of the parent directories): .git",
        });
      });

      await expect(collectDiff({ mode: "unstaged" })).rejects.toMatchObject({
        name: "DiffError",
        code: "not_git_repo",
      });
    });

    it("throws gh_not_installed for pr mode without gh", async () => {
      mockExecFile.mockImplementation((cmd, args, callback: any) => {
        const error = new Error("Command failed") as any;
        error.code = "ENOENT";
        callback(error, { stdout: "", stderr: "" });
      });

      await expect(collectDiff({ mode: "pr", pr: 123 })).rejects.toMatchObject({
        name: "DiffError",
        code: "gh_not_installed",
      });
    });

    it("throws empty_diff when diff output is empty", async () => {
      const fixture = await loadFixture("empty.diff");
      mockExecFile.mockImplementation((cmd, args, callback: any) => {
        callback(null, { stdout: fixture, stderr: "" });
      });

      await expect(collectDiff({ mode: "unstaged" })).rejects.toMatchObject({
        name: "DiffError",
        code: "empty_diff",
      });
    });

    it("throws base_not_found when base branch missing", async () => {
      mockExecFile.mockImplementation((cmd, args, callback: any) => {
        callback(null, {
          stdout: "",
          stderr: "fatal: ambiguous argument 'nonexistent...HEAD': unknown revision or path not in the working tree.",
        });
      });

      await expect(collectDiff({ mode: "branch", base: "nonexistent" })).rejects.toMatchObject({
        name: "DiffError",
        code: "base_not_found",
      });
    });

    it("throws pr_not_found for invalid PR number", async () => {
      mockExecFile.mockImplementation((cmd, args, callback: any) => {
        callback(null, {
          stdout: "",
          stderr: "no pull requests found",
        });
      });

      await expect(collectDiff({ mode: "pr", pr: 99999 })).rejects.toMatchObject({
        name: "DiffError",
        code: "pr_not_found",
      });
    });

    it("throws invalid_ref for nonexistent refs in range mode", async () => {
      mockExecFile.mockImplementation((cmd, args, callback: any) => {
        callback(null, {
          stdout: "",
          stderr: "fatal: ambiguous argument 'v1.0..v2.0': unknown revision or path not in the working tree.",
        });
      });

      await expect(collectDiff({ mode: "range", range: "v1.0..v2.0" })).rejects.toMatchObject({
        name: "DiffError",
        code: "invalid_ref",
      });
    });

    it("throws insufficient_history for shallow clone with HEAD~N", async () => {
      mockExecFile.mockImplementation((cmd, args, callback: any) => {
        callback(null, {
          stdout: "",
          stderr: "fatal: ambiguous argument 'HEAD~5': unknown revision or path not in the working tree.",
        });
      });

      await expect(collectDiff({ mode: "commits", count: 5 })).rejects.toMatchObject({
        name: "DiffError",
        code: "insufficient_history",
      });
    });

    it("throws no_commits when repo has no commits", async () => {
      mockExecFile.mockImplementation((cmd, args, callback: any) => {
        callback(null, {
          stdout: "",
          stderr: "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.",
        });
      });

      await expect(collectDiff({ mode: "local" })).rejects.toMatchObject({
        name: "DiffError",
        code: "no_commits",
      });
    });

    it("throws diff_too_large when raw exceeds 10 MB", async () => {
      const largeDiff = "a".repeat(11 * 1024 * 1024); // 11 MB
      mockExecFile.mockImplementation((cmd, args, callback: any) => {
        callback(null, { stdout: largeDiff, stderr: "" });
      });

      await expect(collectDiff({ mode: "unstaged" })).rejects.toMatchObject({
        name: "DiffError",
        code: "diff_too_large",
      });
    });

    it("respects LLM_REVIEWER_MAX_DIFF_SIZE env var for size limit", async () => {
      process.env.LLM_REVIEWER_MAX_DIFF_SIZE = "1048576"; // 1 MB
      const largeDiff = "a".repeat(2 * 1024 * 1024); // 2 MB
      mockExecFile.mockImplementation((cmd, args, callback: any) => {
        callback(null, { stdout: largeDiff, stderr: "" });
      });

      await expect(collectDiff({ mode: "unstaged" })).rejects.toMatchObject({
        name: "DiffError",
        code: "diff_too_large",
      });
    });

    it("falls back to default size limit when env var is invalid", async () => {
      process.env.LLM_REVIEWER_MAX_DIFF_SIZE = "invalid";
      const largeDiff = "a".repeat(11 * 1024 * 1024); // 11 MB (exceeds default 10MB)
      mockExecFile.mockImplementation((cmd, args, callback: any) => {
        callback(null, { stdout: largeDiff, stderr: "" });
      });

      await expect(collectDiff({ mode: "unstaged" })).rejects.toMatchObject({
        name: "DiffError",
        code: "diff_too_large",
      });
    });

    it("falls back to default size limit when env var is negative", async () => {
      process.env.LLM_REVIEWER_MAX_DIFF_SIZE = "-100";
      const largeDiff = "a".repeat(11 * 1024 * 1024); // 11 MB (exceeds default 10MB)
      mockExecFile.mockImplementation((cmd, args, callback: any) => {
        callback(null, { stdout: largeDiff, stderr: "" });
      });

      // Should throw diff_too_large because we fall back to default 10MB limit
      await expect(collectDiff({ mode: "unstaged" })).rejects.toMatchObject({
        name: "DiffError",
        code: "diff_too_large",
      });
    });
  });

  describe("security", () => {
    it("passes user input as array arguments, not interpolated into strings", async () => {
      const maliciousBase = "main; rm -rf /";
      mockExecFile.mockImplementation((cmd, args, callback: any) => {
        // Verify args is an array and malicious input is passed as a single element
        expect(Array.isArray(args)).toBe(true);
        expect(args).toContain(`${maliciousBase}...HEAD`);
        // Should not be split or interpreted
        expect(args).not.toContain("rm");
        callback(null, { stdout: "", stderr: "" });
      });

      await expect(collectDiff({ mode: "branch", base: maliciousBase })).rejects.toThrow();
    });
  });
});
