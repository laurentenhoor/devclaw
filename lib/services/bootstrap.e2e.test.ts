/**
 * E2E bootstrap tests — verifies the full before_agent_start hook chain:
 *   dispatchTask() → session key → before_agent_start fires → prependContext returned
 *
 * Uses simulateBootstrap() which registers the real hook with a mock API,
 * fires it with the session key from dispatch, and returns the hook result
 * containing prependContext — proving instructions actually reach the worker.
 *
 * Run: npx tsx --test lib/services/bootstrap.e2e.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { createTestHarness, type TestHarness } from "../testing/index.js";
import { dispatchTask } from "../dispatch.js";

describe("E2E bootstrap — hook injection", () => {
  let h: TestHarness;

  afterEach(async () => {
    if (h) await h.cleanup();
  });

  it("should inject project-specific instructions via prependContext", async () => {
    h = await createTestHarness({ projectName: "my-app" });
    h.provider.seedIssue({ iid: 1, title: "Add feature", labels: ["To Do"] });

    // Write both default and project-specific prompts
    await h.writePrompt("developer", "# Default Developer\nGeneric instructions.");
    await h.writePrompt("developer", "# My App Developer\nUse React. Follow our design system.", "my-app");

    // Dispatch to get the session key
    const result = await dispatchTask({
      workspaceDir: h.workspaceDir,
      agentId: "main",
      project: h.project,
      issueId: 1,
      issueTitle: "Add feature",
      issueDescription: "",
      issueUrl: "https://example.com/issues/1",
      role: "developer",
      level: "medior",
      fromLabel: "To Do",
      toLabel: "Doing",
      provider: h.provider,
    });

    // Fire the actual before_agent_start hook with the dispatch session key
    const result2 = await h.simulateBootstrap(result.sessionKey);

    // Hook should return prependContext with project-specific role instructions
    assert.ok(result2?.prependContext, "Expected prependContext to be set");
    const content = result2.prependContext;
    assert.ok(content.includes("My App Developer"), `Got: ${content}`);
    assert.ok(content.includes("Use React"));
    assert.ok(!content.includes("Generic instructions"));
  });

  it("should fall back to default instructions when no project override exists", async () => {
    h = await createTestHarness({ projectName: "other-app" });
    h.provider.seedIssue({ iid: 2, title: "Fix bug", labels: ["To Do"] });

    // Only write default prompt — no project-specific
    await h.writePrompt("developer", "# Default Developer\nFollow coding standards.");

    const result = await dispatchTask({
      workspaceDir: h.workspaceDir,
      agentId: "main",
      project: h.project,
      issueId: 2,
      issueTitle: "Fix bug",
      issueDescription: "",
      issueUrl: "https://example.com/issues/2",
      role: "developer",
      level: "junior",
      fromLabel: "To Do",
      toLabel: "Doing",
      provider: h.provider,
    });

    const hookResult = await h.simulateBootstrap(result.sessionKey);

    assert.ok(hookResult?.prependContext, "Expected prependContext to be set");
    assert.ok(hookResult.prependContext.includes("Default Developer"));
    assert.ok(hookResult.prependContext.includes("Follow coding standards"));
  });

  it("should inject scaffolded default instructions when no overrides exist", async () => {
    h = await createTestHarness({ projectName: "bare-app" });
    h.provider.seedIssue({ iid: 3, title: "Chore", labels: ["To Do"] });

    // Don't write any custom prompts — ensureWorkspaceMigrated scaffolds defaults

    const result = await dispatchTask({
      workspaceDir: h.workspaceDir,
      agentId: "main",
      project: h.project,
      issueId: 3,
      issueTitle: "Chore",
      issueDescription: "",
      issueUrl: "https://example.com/issues/3",
      role: "developer",
      level: "medior",
      fromLabel: "To Do",
      toLabel: "Doing",
      provider: h.provider,
    });

    const hookResult = await h.simulateBootstrap(result.sessionKey);

    // Default developer instructions are scaffolded by ensureDefaultFiles
    assert.ok(hookResult?.prependContext, "Expected prependContext to be set");
    assert.ok(hookResult.prependContext.includes("DEVELOPER"), "Should contain DEVELOPER heading");
    assert.ok(hookResult.prependContext.includes("worktree"), "Should reference git worktree workflow");
  });

  it("should NOT inject anything for unknown custom roles", async () => {
    h = await createTestHarness({ projectName: "custom-app" });

    // Simulate a session key for a custom role that has no prompt file
    // This key won't parse because "investigator" isn't in the role registry
    const hookResult = await h.simulateBootstrap(
      "agent:main:subagent:custom-app-investigator-medior",
    );

    // Hook should no-op (return undefined) — unknown role doesn't match pattern
    assert.strictEqual(hookResult, undefined, "Should not return anything for unknown roles");
  });

  it("should resolve tester instructions independently from developer", async () => {
    h = await createTestHarness({ projectName: "multi-role" });
    h.provider.seedIssue({ iid: 4, title: "Test thing", labels: ["To Test"] });

    // Write project-specific for developer, default for tester
    await h.writePrompt("developer", "# Dev for multi-role\nSpecific dev rules.", "multi-role");
    await h.writePrompt("tester", "# Default Tester\nRun integration tests.");

    // Dispatch as tester
    const result = await dispatchTask({
      workspaceDir: h.workspaceDir,
      agentId: "main",
      project: h.project,
      issueId: 4,
      issueTitle: "Test thing",
      issueDescription: "",
      issueUrl: "https://example.com/issues/4",
      role: "tester",
      level: "medior",
      fromLabel: "To Test",
      toLabel: "Testing",
      provider: h.provider,
    });

    // Simulate bootstrap for the tester session
    const testerResult = await h.simulateBootstrap(result.sessionKey);
    assert.ok(testerResult?.prependContext, "Expected tester prependContext");
    assert.ok(testerResult.prependContext.includes("Default Tester"));
    assert.ok(!testerResult.prependContext.includes("Dev for multi-role"));

    // Simulate bootstrap for a developer session on the same project
    const devKey = result.sessionKey.replace("-tester-", "-developer-");
    const devResult = await h.simulateBootstrap(devKey);
    assert.ok(devResult?.prependContext, "Expected developer prependContext");
    assert.ok(devResult.prependContext.includes("Dev for multi-role"));
    assert.ok(devResult.prependContext.includes("Specific dev rules"));
  });

  it("should handle project names with hyphens correctly", async () => {
    h = await createTestHarness({ projectName: "my-cool-project" });
    h.provider.seedIssue({ iid: 5, title: "Hyphen test", labels: ["To Do"] });

    await h.writePrompt(
      "developer",
      "# Hyphenated Project\nThis project has hyphens in the name.",
      "my-cool-project",
    );

    const result = await dispatchTask({
      workspaceDir: h.workspaceDir,
      agentId: "main",
      project: h.project,
      issueId: 5,
      issueTitle: "Hyphen test",
      issueDescription: "",
      issueUrl: "https://example.com/issues/5",
      role: "developer",
      level: "senior",
      fromLabel: "To Do",
      toLabel: "Doing",
      provider: h.provider,
    });

    const hookResult = await h.simulateBootstrap(result.sessionKey);

    assert.ok(hookResult?.prependContext, "Expected prependContext to be set");
    assert.ok(hookResult.prependContext.includes("Hyphenated Project"));
  });

  it("should resolve architect instructions with project override", async () => {
    h = await createTestHarness({ projectName: "arch-proj" });
    h.provider.seedIssue({ iid: 6, title: "Design API", labels: ["Planning"] });

    await h.writePrompt("architect", "# Default Architect\nGeneral design guidelines.");
    await h.writePrompt("architect", "# Arch Proj Architect\nUse event-driven architecture.", "arch-proj");

    const result = await dispatchTask({
      workspaceDir: h.workspaceDir,
      agentId: "main",
      project: h.project,
      issueId: 6,
      issueTitle: "Design API",
      issueDescription: "",
      issueUrl: "https://example.com/issues/6",
      role: "architect",
      level: "senior",
      fromLabel: "Planning",
      toLabel: "Planning",
      provider: h.provider,
    });

    const hookResult = await h.simulateBootstrap(result.sessionKey);

    assert.ok(hookResult?.prependContext, "Expected prependContext to be set");
    assert.ok(hookResult.prependContext.includes("Arch Proj Architect"));
    assert.ok(hookResult.prependContext.includes("event-driven"));
    assert.ok(!hookResult.prependContext.includes("General design guidelines"));
  });

  it("should not inject when session key is not a DevClaw subagent", async () => {
    h = await createTestHarness();

    // Non-DevClaw session key — hook should no-op (return undefined)
    const hookResult = await h.simulateBootstrap("agent:main:orchestrator");
    assert.strictEqual(hookResult, undefined, "Should not return anything for non-DevClaw sessions");
  });
});
