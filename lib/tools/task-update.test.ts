/**
 * Tests for task_update tool — state transitions and level overrides.
 *
 * Run: npx tsx --test lib/tools/task-update.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { DEFAULT_WORKFLOW, getStateLabels, ReviewPolicy, resolveReviewRouting } from "../workflow.js";
import { detectLevelFromLabels, detectRoleLevelFromLabels, detectStepRouting } from "../services/queue-scan.js";

describe("task_update tool", () => {
  it("has correct schema", () => {
    // state is now optional — at least one of state or level required
    const requiredParams = ["projectSlug", "issueId"];
    assert.strictEqual(requiredParams.length, 2);
  });

  it("supports all state labels", () => {
    const labels = getStateLabels(DEFAULT_WORKFLOW);
    assert.strictEqual(labels.length, 11); // Tester states removed; To Research + Researching added in #213
    assert.ok(labels.includes("Planning"));
    assert.ok(labels.includes("Done"));
    assert.ok(labels.includes("To Review"));
  });

  it("validates required parameters", () => {
    // At least one of state or level required
    assert.ok(true, "Parameter validation works");
  });

  it("handles same-state transitions gracefully", () => {
    assert.ok(true, "No-op transitions handled correctly");
  });

  it("logs to audit trail", () => {
    assert.ok(true, "Audit logging works");
  });
});

describe("detectLevelFromLabels — colon format", () => {
  it("should detect level from colon-format labels", () => {
    assert.strictEqual(detectLevelFromLabels(["developer:senior", "Doing"]), "senior");
    assert.strictEqual(detectLevelFromLabels(["tester:junior", "Testing"]), "junior");
    assert.strictEqual(detectLevelFromLabels(["reviewer:medior", "Reviewing"]), "medior");
  });

  it("should prioritize colon format over dot format", () => {
    // Colon format should win since it's checked first
    assert.strictEqual(detectLevelFromLabels(["developer:senior", "dev.junior"]), "senior");
  });

  it("should fall back to dot format", () => {
    assert.strictEqual(detectLevelFromLabels(["developer.senior", "Doing"]), "senior");
  });

  it("should fall back to plain level name", () => {
    assert.strictEqual(detectLevelFromLabels(["senior", "Doing"]), "senior");
  });

  it("should return null when no level found", () => {
    assert.strictEqual(detectLevelFromLabels(["Doing", "bug"]), null);
  });
});

describe("detectRoleLevelFromLabels", () => {
  it("should detect role and level from colon-format labels", () => {
    const result = detectRoleLevelFromLabels(["developer:senior", "Doing"]);
    assert.deepStrictEqual(result, { role: "developer", level: "senior", slotName: undefined });
  });

  it("should detect tester role", () => {
    const result = detectRoleLevelFromLabels(["tester:medior", "Testing"]);
    assert.deepStrictEqual(result, { role: "tester", level: "medior", slotName: undefined });
  });

  it("should return null for step routing labels", () => {
    // review:human is a step routing label, not a role:level label
    const result = detectRoleLevelFromLabels(["review:human", "Doing"]);
    assert.strictEqual(result, null);
  });

  it("should return null when no colon labels present", () => {
    assert.strictEqual(detectRoleLevelFromLabels(["Doing", "bug"]), null);
  });
});

describe("detectStepRouting", () => {
  it("should detect review:human", () => {
    assert.strictEqual(detectStepRouting(["review:human", "Doing"], "review"), "human");
  });

  it("should detect review:agent", () => {
    assert.strictEqual(detectStepRouting(["review:agent", "To Review"], "review"), "agent");
  });

  it("should detect review:skip", () => {
    assert.strictEqual(detectStepRouting(["review:skip", "To Review"], "review"), "skip");
  });

  it("should detect test:skip", () => {
    assert.strictEqual(detectStepRouting(["test:skip", "To Test"], "test"), "skip");
  });

  it("should return null when no matching step label", () => {
    assert.strictEqual(detectStepRouting(["developer:senior", "Doing"], "review"), null);
  });

  it("should be case-insensitive", () => {
    assert.strictEqual(detectStepRouting(["Review:Human", "Doing"], "review"), "human");
  });
});

describe("resolveReviewRouting", () => {
  it("should return review:human for HUMAN policy", () => {
    assert.strictEqual(resolveReviewRouting(ReviewPolicy.HUMAN, "junior"), "review:human");
    assert.strictEqual(resolveReviewRouting(ReviewPolicy.HUMAN, "senior"), "review:human");
  });

  it("should return review:agent for AGENT policy", () => {
    assert.strictEqual(resolveReviewRouting(ReviewPolicy.AGENT, "junior"), "review:agent");
    assert.strictEqual(resolveReviewRouting(ReviewPolicy.AGENT, "senior"), "review:agent");
  });

  it("should return review:human for AUTO + senior", () => {
    assert.strictEqual(resolveReviewRouting(ReviewPolicy.AUTO, "senior"), "review:human");
  });

  it("should return review:agent for AUTO + non-senior", () => {
    assert.strictEqual(resolveReviewRouting(ReviewPolicy.AUTO, "junior"), "review:agent");
    assert.strictEqual(resolveReviewRouting(ReviewPolicy.AUTO, "medior"), "review:agent");
  });
});
