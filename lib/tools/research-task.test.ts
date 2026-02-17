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
import { buildResearchTaskMessage } from "../dispatch.js";

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

describe("research dispatch — no pre-existing issue", () => {
  it("should build research task message with title and description", () => {
    const msg = buildResearchTaskMessage({
      projectName: "my-project",
      role: "architect",
      researchTitle: "Research: Cache strategy",
      researchDescription: "Currently using in-memory cache",
      focusAreas: ["Redis", "Memcached"],
      repo: "~/git/my-project",
      baseBranch: "main",
      groupId: "-123456",
    });
    assert.ok(msg.includes("Research: Cache strategy"), "should include title");
    assert.ok(msg.includes("Currently using in-memory cache"), "should include description");
    assert.ok(msg.includes("Redis"), "should include focus areas");
    assert.ok(msg.includes("work_finish"), "should include work_finish instruction");
    assert.ok(msg.includes('"done"'), "should include done result");
    assert.ok(msg.includes("summary"), "should mention summary");
    assert.ok(msg.includes("becomes the issue body"), "should explain summary becomes issue body");
  });

  it("should include project group ID in research message", () => {
    const msg = buildResearchTaskMessage({
      projectName: "webapp",
      role: "architect",
      researchTitle: "Research: Auth refactor",
      researchDescription: "Session handling needs redesign",
      focusAreas: [],
      repo: "~/git/webapp",
      baseBranch: "development",
      groupId: "-999",
    });
    assert.ok(msg.includes("-999"), "should include project group ID");
    assert.ok(msg.includes("webapp"), "should include project name");
  });

  it("should omit focus areas section when empty", () => {
    const msg = buildResearchTaskMessage({
      projectName: "proj",
      role: "architect",
      researchTitle: "Research: DB strategy",
      researchDescription: "Need to pick a database",
      focusAreas: [],
      repo: "~/git/proj",
      baseBranch: "main",
      groupId: "-1",
    });
    assert.ok(!msg.includes("## Focus Areas"), "should not include Focus Areas section when empty");
  });

  it("should include focus areas section when present", () => {
    const msg = buildResearchTaskMessage({
      projectName: "proj",
      role: "architect",
      researchTitle: "Research: DB strategy",
      researchDescription: "Need to pick a database",
      focusAreas: ["SQLite", "PostgreSQL", "MySQL"],
      repo: "~/git/proj",
      baseBranch: "main",
      groupId: "-1",
    });
    assert.ok(msg.includes("## Focus Areas"), "should include Focus Areas section");
    assert.ok(msg.includes("- SQLite"), "should include individual focus areas");
    assert.ok(msg.includes("- PostgreSQL"), "should include individual focus areas");
  });
});
