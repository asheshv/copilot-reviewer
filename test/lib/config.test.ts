// test/lib/config.test.ts
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "child_process";
import { readFile, access } from "fs/promises";
import { homedir } from "os";
import { loadConfig } from "../../src/lib/config.js";
import { ConfigError } from "../../src/lib/types.js";
import type { CLIOverrides } from "../../src/lib/types.js";

// Mock dependencies
vi.mock("child_process", () => ({ execFile: vi.fn() }));
vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
  access: vi.fn(),
}));
vi.mock("os", () => ({ homedir: vi.fn() }));

const mockExecFile = vi.mocked(execFile);
const mockReadFile = vi.mocked(readFile);
const mockAccess = vi.mocked(access);
const mockHomedir = vi.mocked(homedir);

// Store original cwd
let originalCwd: string;

beforeEach(() => {
  vi.resetAllMocks();
  originalCwd = process.cwd();
  mockHomedir.mockReturnValue("/home/user");
});

afterEach(() => {
  process.chdir(originalCwd);
});

// Helper to setup git root detection
function mockGitRoot(root: string | null) {
  if (root === null) {
    mockExecFile.mockImplementation((cmd, args, callback: any) => {
      callback(new Error("Not a git repository"), { stdout: "", stderr: "" });
    });
  } else {
    mockExecFile.mockImplementation((cmd, args, callback: any) => {
      expect(cmd).toBe("git");
      expect(args).toEqual(["rev-parse", "--show-toplevel"]);
      callback(null, { stdout: root + "\n", stderr: "" });
    });
  }
}

// Helper to load real fixture file (bypasses mocks by using dynamic import of original module)
async function loadRealFixture(relativePath: string): Promise<string> {
  const path = new URL(`../fixtures/configs/${relativePath}`, import.meta.url);
  // Import the actual fs module, not the mocked one
  const { readFile: actualReadFile } = await vi.importActual<typeof import("fs/promises")>("fs/promises");
  return actualReadFile(path, "utf-8");
}

// Helper to create ENOENT error
function createENOENT(): Error {
  const error = new Error("ENOENT") as any;
  error.code = "ENOENT";
  return error;
}

describe("loadConfig", () => {
  describe("built-in defaults only", () => {
    it("returns defaults when no config files exist", async () => {
      mockGitRoot(null);
      mockAccess.mockRejectedValue(createENOENT());

      const config = await loadConfig();

      expect(config.model).toBe("auto");
      expect(config.format).toBe("markdown");
      expect(config.stream).toBe(true);
      expect(config.defaultBase).toBe("main");
      expect(config.ignorePaths).toEqual([]);
      expect(config.prompt).toContain("Code Review Guidelines");
    });
  });

  describe("global config layer", () => {
    it("merges global config.json over defaults", async () => {
      mockGitRoot(null);
      const globalConfig = await loadRealFixture("global/config.json");

      mockAccess.mockImplementation(async (path: any) => {
        const pathStr = String(path);
        if (pathStr.includes(".copilot-review/config.json")) {
          return;
        }
        throw createENOENT();
      });

      mockReadFile.mockImplementation(async (path: any) => {
        const pathStr = String(path);
        if (pathStr.includes(".copilot-review/config.json")) {
          return globalConfig as any;
        }
        throw createENOENT();
      });

      const config = await loadConfig();

      expect(config.model).toBe("gpt-4.1");
      expect(config.ignorePaths).toEqual(["*.lock"]);
    });

    it("uses config.md when config.json does not exist", async () => {
      mockGitRoot(null);
      const globalMd = await loadRealFixture("global/config.md");

      mockAccess.mockImplementation(async (path: any) => {
        if (path.includes("config.md")) {
          return;
        }
        throw createENOENT();
      });

      mockReadFile.mockImplementation(async (path: any) => {
        if (path.includes("config.md")) {
          return globalMd;
        }
        throw createENOENT();
      });

      const config = await loadConfig();

      expect(config.prompt).toContain("Code Review Guidelines");
      expect(config.prompt).toContain("## Additional Instructions (Global)");
      expect(config.prompt).toContain(globalMd);
    });

    it("prefers config.json prompt over config.md", async () => {
      mockGitRoot(null);
      const globalJson = '{ "prompt": "JSON prompt" }';
      const globalMd = "MD prompt";

      mockAccess.mockResolvedValue(undefined);

      mockReadFile.mockImplementation(async (path: any) => {
        if (path.includes("config.json")) {
          return globalJson;
        }
        if (path.includes("config.md")) {
          return globalMd;
        }
        throw createENOENT();
      });

      const config = await loadConfig();

      expect(config.prompt).toContain("JSON prompt");
      expect(config.prompt).not.toContain("MD prompt");
    });

    it("throws ConfigError on malformed JSON", async () => {
      mockGitRoot(null);
      const malformedJson = await loadRealFixture("malformed/config.json");

      mockAccess.mockImplementation(async (path: any) => {
        if (path.includes("config.json")) {
          return;
        }
        throw createENOENT();
      });

      mockReadFile.mockImplementation(async (path: any) => {
        if (path.includes("config.json")) {
          return malformedJson;
        }
        throw createENOENT();
      });

      await expect(loadConfig()).rejects.toThrow(ConfigError);
      await expect(loadConfig()).rejects.toMatchObject({
        code: "malformed_json",
        name: "ConfigError",
      });
    });
  });

  describe("project config layer", () => {
    it("merges project config over global", async () => {
      mockGitRoot("/project");
      const globalJson = '{ "model": "gpt-4.1", "ignorePaths": ["*.lock"] }';
      const projectJson = await loadRealFixture("project/config.json");

      mockAccess.mockResolvedValue(undefined);

      mockReadFile.mockImplementation(async (path: any) => {
        if (path.includes("/home/user/.copilot-review/config.json")) {
          return globalJson;
        }
        if (path.includes("/project/.copilot-review/config.json")) {
          return projectJson;
        }
        if (path.includes("config.md")) {
          throw createENOENT();
        }
        throw createENOENT();
      });

      const config = await loadConfig();

      expect(config.model).toBe("gpt-4.1");
      expect(config.defaultBase).toBe("develop");
    });

    it("skips project layer if git root detection fails", async () => {
      mockGitRoot(null);
      const globalJson = '{ "model": "gpt-4.1" }';

      mockAccess.mockImplementation(async (path: any) => {
        if (path.includes("/home/user/.copilot-review/config.json")) {
          return;
        }
        throw createENOENT();
      });

      mockReadFile.mockImplementation(async (path: any) => {
        if (path.includes("/home/user/.copilot-review/config.json")) {
          return globalJson;
        }
        throw createENOENT();
      });

      const config = await loadConfig();

      expect(config.model).toBe("gpt-4.1");
    });
  });

  describe("CLI overrides layer", () => {
    it("CLI overrides have highest precedence", async () => {
      mockGitRoot(null);
      mockAccess.mockRejectedValue(createENOENT());

      const overrides: CLIOverrides = {
        model: "gpt-4-turbo",
        format: "json",
        stream: false,
        prompt: "CLI prompt",
      };

      const config = await loadConfig(overrides);

      expect(config.model).toBe("gpt-4-turbo");
      expect(config.format).toBe("json");
      expect(config.stream).toBe(false);
      expect(config.prompt).toBe("CLI prompt");
    });

    it("CLI prompt is implicit replace mode", async () => {
      mockGitRoot(null);
      const globalJson = '{ "prompt": "Global instructions" }';

      mockAccess.mockImplementation(async (path: any) => {
        if (path.includes("config.json")) {
          return;
        }
        throw createENOENT();
      });

      mockReadFile.mockImplementation(async (path: any) => {
        if (path.includes("config.json")) {
          return globalJson;
        }
        throw createENOENT();
      });

      const config = await loadConfig({ prompt: "CLI only" });

      expect(config.prompt).toBe("CLI only");
      expect(config.prompt).not.toContain("Global instructions");
      expect(config.prompt).not.toContain("Code Review Guidelines");
    });
  });

  describe("prompt merge modes", () => {
    it("extend mode appends with section headers", async () => {
      mockGitRoot("/project");
      const globalJson = '{ "prompt": "Global rules" }';
      const projectExtendJson = await loadRealFixture("project-extend/config.json");
      const projectMd = "Project rules";

      mockAccess.mockResolvedValue(undefined);

      mockReadFile.mockImplementation(async (path: any) => {
        if (path.includes("/home/user/.copilot-review/config.json")) {
          return globalJson;
        }
        if (path.includes("/project/.copilot-review/config.json")) {
          return projectExtendJson;
        }
        if (path.includes("/project/.copilot-review/config.md")) {
          return projectMd;
        }
        throw createENOENT();
      });

      const config = await loadConfig();

      expect(config.prompt).toContain("Code Review Guidelines");
      expect(config.prompt).toContain("## Additional Instructions (Global)");
      expect(config.prompt).toContain("Global rules");
      expect(config.prompt).toContain("## Project Instructions");
      expect(config.prompt).toContain("Project rules");
    });

    it("replace mode discards everything below", async () => {
      mockGitRoot("/project");
      const globalJson = '{ "prompt": "Global rules" }';
      const projectJson = await loadRealFixture("project/config.json");
      const projectMd = await loadRealFixture("project/config.md");

      mockAccess.mockResolvedValue(undefined);

      mockReadFile.mockImplementation(async (path: any) => {
        if (path.includes("/home/user/.copilot-review/config.json")) {
          return globalJson;
        }
        if (path.includes("/project/.copilot-review/config.json")) {
          return projectJson;
        }
        if (path.includes("/project/.copilot-review/config.md")) {
          return projectMd;
        }
        throw createENOENT();
      });

      const config = await loadConfig();

      expect(config.prompt).toContain("Focus on React component patterns");
      expect(config.prompt).not.toContain("Code Review Guidelines");
      expect(config.prompt).not.toContain("Global rules");
    });
  });

  describe("ignorePaths merging", () => {
    it("unions ignorePaths across layers", async () => {
      mockGitRoot("/project");
      const globalJson = '{ "ignorePaths": ["*.lock", "dist/**"] }';
      const projectJson = '{ "ignorePaths": ["vendor/**", "*.lock"] }';

      mockAccess.mockImplementation(async (path: any) => {
        if (path.includes("config.json")) {
          return;
        }
        throw createENOENT();
      });

      mockReadFile.mockImplementation(async (path: any) => {
        if (path.includes("/home/user/.copilot-review/config.json")) {
          return globalJson;
        }
        if (path.includes("/project/.copilot-review/config.json")) {
          return projectJson;
        }
        throw createENOENT();
      });

      const config = await loadConfig();

      expect(config.ignorePaths).toHaveLength(3);
      expect(config.ignorePaths).toContain("*.lock");
      expect(config.ignorePaths).toContain("dist/**");
      expect(config.ignorePaths).toContain("vendor/**");
    });

    it("deduplicates ignorePaths", async () => {
      mockGitRoot(null);
      const globalJson = '{ "ignorePaths": ["*.lock", "dist/**", "*.lock"] }';

      mockAccess.mockImplementation(async (path: any) => {
        if (path.includes("config.json")) {
          return;
        }
        throw createENOENT();
      });

      mockReadFile.mockImplementation(async (path: any) => {
        if (path.includes("config.json")) {
          return globalJson;
        }
        throw createENOENT();
      });

      const config = await loadConfig();

      expect(config.ignorePaths).toEqual(["*.lock", "dist/**"]);
    });
  });

  describe("prompt path resolution", () => {
    it("resolves relative .md path from config directory", async () => {
      mockGitRoot(null);
      const pathPromptJson = await loadRealFixture("path-prompt/config.json");
      const customMd = await loadRealFixture("path-prompt/custom.md");

      mockAccess.mockResolvedValue(undefined);

      mockReadFile.mockImplementation(async (path: any) => {
        if (path.includes("path-prompt") && path.includes("config.json")) {
          return pathPromptJson;
        }
        if (path.includes("custom.md")) {
          return customMd;
        }
        throw createENOENT();
      });

      // Override homedir to point to test fixtures
      const fixturesPath = new URL("../fixtures/configs/path-prompt", import.meta.url).pathname;
      mockHomedir.mockReturnValue(fixturesPath.replace("/.copilot-review", ""));

      const config = await loadConfig();

      expect(config.prompt).toContain("Custom prompt content");
    });

    it("throws ConfigError when prompt file path does not exist", async () => {
      mockGitRoot(null);
      const json = '{ "prompt": "missing.md" }';

      mockAccess.mockImplementation(async (path: any) => {
        if (path.includes("config.json")) {
          return;
        }
        throw createENOENT();
      });

      mockReadFile.mockImplementation(async (path: any) => {
        if (path.includes("config.json")) {
          return json;
        }
        throw createENOENT();
      });

      await expect(loadConfig()).rejects.toThrow(ConfigError);
      await expect(loadConfig()).rejects.toMatchObject({
        code: "prompt_not_found",
      });
    });

    it("treats inline text as prompt when not a .md file", async () => {
      mockGitRoot(null);
      const json = '{ "prompt": "This is inline text not a file path" }';

      mockAccess.mockImplementation(async (path: any) => {
        if (path.includes("config.json")) {
          return;
        }
        throw createENOENT();
      });

      mockReadFile.mockImplementation(async (path: any) => {
        if (path.includes("config.json")) {
          return json;
        }
        throw createENOENT();
      });

      const config = await loadConfig();

      expect(config.prompt).toContain("This is inline text not a file path");
    });
  });

  describe("edge cases", () => {
    it("treats empty config.md as no contribution", async () => {
      mockGitRoot(null);
      const emptyMd = await loadRealFixture("empty/config.md");

      mockAccess.mockImplementation(async (path: any) => {
        if (path.includes("config.md")) {
          return;
        }
        throw createENOENT();
      });

      mockReadFile.mockImplementation(async (path: any) => {
        if (path.includes("config.md")) {
          return emptyMd;
        }
        throw createENOENT();
      });

      const config = await loadConfig();

      expect(config.prompt).toContain("Code Review Guidelines");
      expect(config.prompt).not.toContain("## Additional Instructions (Global)");
    });

    it("treats whitespace-only config.md as no contribution", async () => {
      mockGitRoot(null);

      mockAccess.mockImplementation(async (path: any) => {
        if (path.includes("config.md")) {
          return;
        }
        throw createENOENT();
      });

      mockReadFile.mockImplementation(async (path: any) => {
        if (path.includes("config.md")) {
          return "   \n\t\n  ";
        }
        throw createENOENT();
      });

      const config = await loadConfig();

      expect(config.prompt).toContain("Code Review Guidelines");
      expect(config.prompt).not.toContain("## Additional Instructions (Global)");
    });
  });

  describe("--config flag", () => {
    it("replaces project config layer with custom path", async () => {
      mockGitRoot("/project");
      const globalJson = '{ "model": "gpt-4.1" }';
      const customJson = '{ "defaultBase": "staging" }';

      mockAccess.mockResolvedValue(undefined);

      mockReadFile.mockImplementation(async (path: any) => {
        if (path.includes("/home/user/.copilot-review/config.json")) {
          return globalJson;
        }
        if (path.includes("/custom/config.json")) {
          return customJson;
        }
        throw createENOENT();
      });

      const config = await loadConfig({ config: "/custom/config.json" });

      expect(config.model).toBe("gpt-4.1");
      expect(config.defaultBase).toBe("staging");
    });

    it("global config still loads with --config", async () => {
      mockGitRoot(null);
      const globalJson = '{ "ignorePaths": ["*.lock"] }';
      const customJson = '{ "ignorePaths": ["vendor/**"] }';

      mockAccess.mockResolvedValue(undefined);

      mockReadFile.mockImplementation(async (path: any) => {
        if (path.includes("/home/user/.copilot-review/config.json")) {
          return globalJson;
        }
        if (path.includes("/custom/config.json")) {
          return customJson;
        }
        throw createENOENT();
      });

      const config = await loadConfig({ config: "/custom/config.json" });

      expect(config.ignorePaths).toEqual(["*.lock", "vendor/**"]);
    });
  });
});
