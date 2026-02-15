/**
 * Tests for architect role, design_task tool, and workflow integration.
 * Run with: npx tsx --test lib/tools/design-task.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { parseDevClawSessionKey } from "../bootstrap-hook.js";
import { isArchitectLevel, levelRole, resolveModel, defaultModel, levelEmoji } from "../tiers.js";
import { selectLevel } from "../model-selector.js";
import {
  DEFAULT_WORKFLOW, getQueueLabels, getActiveLabel, getCompletionRule,
  getCompletionEmoji, detectRoleFromLabel, getStateLabels,
} from "../workflow.js";

describe("architect tiers", () => {
  it("should recognize architect levels", () => {
    assert.strictEqual(isArchitectLevel("junior"), true);
    assert.strictEqual(isArchitectLevel("senior"), true);
    assert.strictEqual(isArchitectLevel("mid"), false);
  });

  it("should map architect levels to role", () => {
    // "junior" and "senior" appear in dev first (registry order), so roleForLevel returns "dev"
    // This is expected — use isArchitectLevel for architect-specific checks
    assert.strictEqual(levelRole("junior"), "dev");
    assert.strictEqual(levelRole("senior"), "dev");
  });

  it("should resolve default architect models", () => {
    assert.strictEqual(defaultModel("architect", "senior"), "anthropic/claude-opus-4-5");
    assert.strictEqual(defaultModel("architect", "junior"), "anthropic/claude-sonnet-4-5");
  });

  it("should resolve architect model from config", () => {
    const config = { models: { architect: { senior: "custom/model" } } };
    assert.strictEqual(resolveModel("architect", "senior", config), "custom/model");
  });

  it("should have architect emoji", () => {
    assert.strictEqual(levelEmoji("architect", "senior"), "🏗️");
    assert.strictEqual(levelEmoji("architect", "junior"), "📐");
  });
});

describe("architect workflow states", () => {
  it("should include To Design and Designing in state labels", () => {
    const labels = getStateLabels(DEFAULT_WORKFLOW);
    assert.ok(labels.includes("To Design"));
    assert.ok(labels.includes("Designing"));
  });

  it("should have To Design as architect queue label", () => {
    const queues = getQueueLabels(DEFAULT_WORKFLOW, "architect");
    assert.deepStrictEqual(queues, ["To Design"]);
  });

  it("should have Designing as architect active label", () => {
    assert.strictEqual(getActiveLabel(DEFAULT_WORKFLOW, "architect"), "Designing");
  });

  it("should detect architect role from To Design label", () => {
    assert.strictEqual(detectRoleFromLabel(DEFAULT_WORKFLOW, "To Design"), "architect");
  });

  it("should have architect:done completion rule", () => {
    const rule = getCompletionRule(DEFAULT_WORKFLOW, "architect", "done");
    assert.ok(rule);
    assert.strictEqual(rule!.from, "Designing");
    assert.strictEqual(rule!.to, "Planning");
  });

  it("should have architect:blocked completion rule", () => {
    const rule = getCompletionRule(DEFAULT_WORKFLOW, "architect", "blocked");
    assert.ok(rule);
    assert.strictEqual(rule!.from, "Designing");
    assert.strictEqual(rule!.to, "Refining");
  });

  it("should have architect completion emoji", () => {
    assert.strictEqual(getCompletionEmoji("architect", "done"), "🏗️");
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
