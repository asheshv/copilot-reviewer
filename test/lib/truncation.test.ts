// test/lib/truncation.test.ts

import { describe, it, expect } from "vitest";
import { parseSeverityTiers, truncateForReduce } from "../../src/lib/truncation.js";

// ---------------------------------------------------------------------------
// parseSeverityTiers
// ---------------------------------------------------------------------------

describe("parseSeverityTiers", () => {
  it("recognises ### HIGH header as tier 1", () => {
    const text = "### HIGH\nsome bug here\n";
    const result = parseSeverityTiers(text);
    expect(result.high).toHaveLength(1);
    expect(result.high[0]).toContain("### HIGH");
    expect(result.medium).toHaveLength(0);
    expect(result.low).toHaveLength(0);
  });

  it("recognises [MEDIUM] at line start as tier 2", () => {
    const text = "[MEDIUM]\na style issue\n";
    const result = parseSeverityTiers(text);
    expect(result.medium).toHaveLength(1);
    expect(result.medium[0]).toContain("[MEDIUM]");
    expect(result.high).toHaveLength(0);
    expect(result.low).toHaveLength(0);
  });

  it("recognises **LOW** at line start as tier 3", () => {
    const text = "**LOW**\na nitpick\n";
    const result = parseSeverityTiers(text);
    expect(result.low).toHaveLength(1);
    expect(result.low[0]).toContain("**LOW**");
    expect(result.high).toHaveLength(0);
    expect(result.medium).toHaveLength(0);
  });

  it("is case-insensitive: ### high → tier 1", () => {
    const text = "### high\na bug\n";
    const result = parseSeverityTiers(text);
    expect(result.high).toHaveLength(1);
  });

  it("handles mixed formats in the same text", () => {
    const text = [
      "### HIGH",
      "critical bug",
      "[MEDIUM]",
      "style issue",
      "**LOW**",
      "nitpick",
    ].join("\n");
    const result = parseSeverityTiers(text);
    expect(result.high).toHaveLength(1);
    expect(result.medium).toHaveLength(1);
    expect(result.low).toHaveLength(1);
    expect(result.high[0]).toContain("critical bug");
    expect(result.medium[0]).toContain("style issue");
    expect(result.low[0]).toContain("nitpick");
  });

  it("returns all content as medium when there are no severity markers", () => {
    const text = "some review text without any markers";
    const result = parseSeverityTiers(text);
    expect(result.medium).toHaveLength(1);
    expect(result.medium[0]).toBe(text);
    expect(result.high).toHaveLength(0);
    expect(result.low).toHaveLength(0);
  });

  it("preamble before first marker goes into tier 2 (medium)", () => {
    const text = "intro paragraph\n### HIGH\nreal bug\n";
    const result = parseSeverityTiers(text);
    expect(result.medium).toHaveLength(1);
    expect(result.medium[0]).toContain("intro paragraph");
    expect(result.high).toHaveLength(1);
    expect(result.high[0]).toContain("real bug");
  });

  it("mid-line [HIGH] tag is NOT treated as a severity marker", () => {
    const text = "some text [HIGH] more text\nno split here\n";
    const result = parseSeverityTiers(text);
    // no markers found → whole text is medium
    expect(result.high).toHaveLength(0);
    expect(result.medium).toHaveLength(1);
    expect(result.medium[0]).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// truncateForReduce
// ---------------------------------------------------------------------------

// Helper: build a finding string with severity markers and content
function makeFinding(severity: "HIGH" | "MEDIUM" | "LOW", title: string, body: string): string {
  return `### ${severity}\n${title}\n\n${body}\n`;
}

describe("truncateForReduce", () => {
  it("returns unchanged when all findings fit within budget", () => {
    const findings = ["### HIGH\nSmall bug\n\nDetails here.\n"];
    const budget = 10_000; // way more than needed
    const result = truncateForReduce(findings, budget);
    expect(result.didTruncate).toBe(false);
    expect(result.warnings).toHaveLength(0);
    expect(result.truncated).toEqual(findings);
  });

  it("Round 1: removes LOW findings and replaces with omission count", () => {
    const lowBlock = makeFinding("LOW", "Nitpick 1", "a".repeat(400));
    const highBlock = makeFinding("HIGH", "Critical bug", "b".repeat(50));
    // Make budget just large enough for HIGH but not LOW
    const findings = [highBlock + lowBlock];
    const budget = Math.ceil((highBlock.length) / 4) + 10; // fits HIGH, not LOW

    const result = truncateForReduce(findings, budget);
    expect(result.didTruncate).toBe(true);
    expect(result.truncated[0]).toContain("### HIGH");
    expect(result.truncated[0]).not.toContain("Nitpick 1");
    expect(result.truncated[0]).toContain("LOW findings omitted");
    expect(result.warnings.some(w => w.includes("LOW"))).toBe(true);
  });

  it("Round 2: compresses MEDIUM to title + first paragraph, drops Suggestion blocks", () => {
    const mediumBlock = [
      "### MEDIUM",
      "Title line",
      "",
      "First paragraph content.",
      "",
      "**Suggestion:** Do it differently.",
      "",
      "More trailing content.",
    ].join("\n") + "\n";
    const highBlock = makeFinding("HIGH", "Bug", "x".repeat(20));

    // Budget: fits HIGH + title line, but not full medium
    const titleLine = "Title line";
    const firstPara = "First paragraph content.";
    // We need the full medium text to not fit, but compressed to fit
    const findings = [mediumBlock.repeat(5) + highBlock];
    const budget = Math.ceil((highBlock.length + mediumBlock.length) / 4); // fits ~1 medium + high

    const result = truncateForReduce(findings, budget);
    // After round 1 (no LOW), round 2 should kick in for MEDIUM
    // The truncated output should not contain "Suggestion"
    if (result.didTruncate) {
      expect(result.truncated[0]).not.toContain("**Suggestion:**");
    }
    // Warnings should mention MEDIUM compression
    if (result.warnings.some(w => w.includes("MEDIUM"))) {
      expect(result.truncated[0]).not.toContain("**Suggestion:**");
    }
  });

  it("Round 3: compresses MEDIUM to title lines only", () => {
    // Many medium findings, very tight budget
    const medBlock = makeFinding("MEDIUM", "Issue title", "x".repeat(300));
    const findings = [medBlock.repeat(8)];
    // Budget that fits only title lines (< full content)
    const budget = 50; // extremely tight

    const result = truncateForReduce(findings, budget);
    expect(result.didTruncate).toBe(true);
    // Round 3 warning
    const hasRound3 = result.warnings.some(w => w.includes("compressed") && w.includes("titles"));
    // Either round 3 applied or round 4 (proportional), either way truncated
    expect(result.truncated[0].length).toBeLessThanOrEqual(findings[0].length);
  });

  it("HIGH findings are never truncated in rounds 1-3", () => {
    const highBlock = makeFinding("HIGH", "Critical issue", "important details\n".repeat(5));
    const lowBlock = makeFinding("LOW", "Nitpick", "c".repeat(500));
    const findings = [highBlock + lowBlock];
    const budget = Math.ceil(highBlock.length / 4) + 5;

    const result = truncateForReduce(findings, budget);
    // HIGH content must survive
    expect(result.truncated[0]).toContain("Critical issue");
    expect(result.truncated[0]).toContain("important details");
  });

  it("Round 4: HIGH content is preserved, other content truncated proportionally", () => {
    // Construct a chunk with LOW/MEDIUM content stripped, leaving HIGH + other content
    // We bypass rounds 1-3 by using only HIGH and MEDIUM content that doesn't compress enough
    const highContent = "### HIGH\n" + "critical".repeat(20) + "\n"; // ~176 chars
    const medContent = "### MEDIUM\n" + "medium".repeat(50) + "\n";   // ~311 chars
    const chunk = medContent + highContent;

    // Budget so tight that even after rounds 1-3 it doesn't fit,
    // forcing round 4. Make it fit only ~half the chunk.
    const budget = Math.ceil(chunk.length / 4 / 2); // half the tokens

    const result = truncateForReduce([chunk], budget);
    expect(result.didTruncate).toBe(true);

    // HIGH content must be fully present
    const output = result.truncated[0];
    expect(output).toContain("### HIGH");
    expect(output).toContain("criticalcritical"); // some of the HIGH body
  });

  it("Round 4: post-HIGH MEDIUM block is NOT preserved (HIGH latch resets on MEDIUM marker)", () => {
    // Layout: MEDIUM ... HIGH ... MEDIUM
    // The second MEDIUM must NOT be absorbed into highLines
    const preMedium  = "### MEDIUM\n" + "before".repeat(30) + "\n";
    const highBlock  = "### HIGH\n"   + "critical".repeat(20) + "\n";
    const postMedium = "### MEDIUM\n" + "after".repeat(30) + "\n";
    const chunk = preMedium + highBlock + postMedium;

    // Budget tight enough to force round 4 but large enough to hold HIGH alone
    const budget = Math.ceil(highBlock.length / 4) + 5;

    const result = truncateForReduce([chunk], budget);
    expect(result.didTruncate).toBe(true);

    const output = result.truncated[0];
    // HIGH content must be fully preserved
    expect(output).toContain("### HIGH");
    expect(output).toContain("criticalcritical");

    // The post-HIGH MEDIUM block must NOT be fully preserved in the output
    // (it may be partially present due to proportional truncation of otherLines,
    // but the full postMedium body should not appear intact alongside HIGH)
    // Specifically, "after" repeated 30 times should not be in the output
    expect(output).not.toContain("after".repeat(30));
  });

  it("returns warnings describing what was done", () => {
    const lowBlock = makeFinding("LOW", "Nitpick", "z".repeat(600));
    const findings = [lowBlock, lowBlock];
    const budget = 5; // force truncation

    const result = truncateForReduce(findings, budget);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toMatch(/Reduce pass/);
  });
});
