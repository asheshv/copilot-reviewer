import { describe, it, expect } from "vitest";

describe("Provider types", () => {
  it("ReviewProvider module is importable", async () => {
    // Just verify it loads without error
    await import("../../../src/lib/providers/types.js");
    expect(true).toBe(true);
  });
});
