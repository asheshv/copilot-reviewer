// test/lib/smoke.test.ts
import { describe, it, expect } from "vitest";
import { VERSION } from "../../src/lib/index.js";

describe("smoke test", () => {
  it("exports VERSION", () => {
    expect(VERSION).toBe("0.1.0");
  });
});
