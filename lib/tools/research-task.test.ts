/**
 * Tests for architect role, research_task tool, and workflow integration.
 * Run with: npx tsx --test lib/tools/research-task.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { parseDevClawSessionKey } from "../bootstrap-hook.js";
import { isLevelForRole, roleForLevel, resolveModel, getDefaultModel, getEmoji } from "../roles/index.js";
import { selectLevel } from "../model-selector.js";
import {
  DEFAULT_WORKFLOW, getQueueLabels, getCompletionRule,
  getCompletionEmoji, getStateLabels, hasWorkflowStates,
} from "../workflow.js";

describe("architect tiers", () => {
  it("should recognize architect levels", () => {
    assert.strictEqual(isLevelForRole("junior", "architect"), true);
    assert.strictEqual(isLevelForRole("senior", "architect"), true);
    assert.strictEqual(isLevelForRole("medior", "architect"), false);
  });

  it("should map architect levels to role", () => {
    // "junior" and "senior" appear in developer first (registry order), so roleForLevel returns "developer"
    // This is expected — use isLevelForRole for role-specific checks
    assert.strictEqual(roleForLevel("junior"), "developer");
    assert.strictEqual(roleForLevel("senior"), "developer");
  });

  it("should resolve default architect models", () => {
    assert.strictEqual(getDefaultModel("architect", "senior"), "anthropic/claude-opus-4-6");
    assert.strictEqual(getDefaultModel("architect", "junior"), "anthropic/claude-sonnet-4-5");
  });

  it("should resolve architect model from resolved role config", () => {
    const resolvedRole = { models: { senior: "custom/model" }, levels: ["junior", "senior"], defaultLevel: "junior", emoji: {}, completionResults: [] as string[], enabled: true };
    assert.strictEqual(resolveModel("architect", "senior", resolvedRole), "custom/model");
  });

  it("should have architect emoji", () => {
    assert.strictEqual(getEmoji("architect", "senior"), "🏗️");
    assert.strictEqual(getEmoji("architect", "junior"), "📐");
  });
});

describe("architect workflow — no dedicated states", () => {
  it("should NOT have To Design or Designing in state labels", () => {
    const labels = getStateLabels(DEFAULT_WORKFLOW);
    assert.ok(!labels.includes("To Design"), "To Design should not exist");
    assert.ok(!labels.includes("Designing"), "Designing should not exist");
  });

  it("should have no queue labels for architect", () => {
    const queues = getQueueLabels(DEFAULT_WORKFLOW, "architect");
    assert.deepStrictEqual(queues, []);
  });

  it("should report architect has no workflow states", () => {
    assert.strictEqual(hasWorkflowStates(DEFAULT_WORKFLOW, "architect"), false);
  });

  it("should report developer has workflow states", () => {
    assert.strictEqual(hasWorkflowStates(DEFAULT_WORKFLOW, "developer"), true);
  });

  it("should report tester has workflow states", () => {
    assert.strictEqual(hasWorkflowStates(DEFAULT_WORKFLOW, "tester"), true);
  });

  it("should have no completion rules for architect (no active state)", () => {
    const doneRule = getCompletionRule(DEFAULT_WORKFLOW, "architect", "done");
    assert.strictEqual(doneRule, null);
    const blockedRule = getCompletionRule(DEFAULT_WORKFLOW, "architect", "blocked");
    assert.strictEqual(blockedRule, null);
  });

  it("should still have completion emoji for architect results", () => {
    assert.strictEqual(getCompletionEmoji("architect", "done"), "✅");
    assert.strictEqual(getCompletionEmoji("architect", "blocked"), "🚫");
  });
});

describe("architect model selection", () => {
  it("should select junior for standard design tasks", () => {
    const result = selectLevel("Design: Add caching layer", "Simple caching strategy", "architect");
    assert.strictEqual(result.level, "junior");
  });

  it("should select senior for complex design tasks", () => {
    const result = selectLevel("Design: System-wide refactor", "Major migration and redesign of the architecture", "architect");
    assert.strictEqual(result.level, "senior");
  });
});

describe("architect session key parsing", () => {
  it("should parse architect session key", () => {
    const result = parseDevClawSessionKey("agent:devclaw:subagent:my-project-architect-senior");
    assert.deepStrictEqual(result, { projectName: "my-project", role: "architect" });
  });

  it("should parse architect junior session key", () => {
    const result = parseDevClawSessionKey("agent:devclaw:subagent:webapp-architect-junior");
    assert.deepStrictEqual(result, { projectName: "webapp", role: "architect" });
  });
});
