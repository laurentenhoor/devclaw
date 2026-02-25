/**
 * E2E bootstrap tests — verifies role instructions reach workers via extraSystemPrompt:
 *   dispatchTask() → loadRoleInstructions() → gateway agent call includes extraSystemPrompt
 *
 * Also tests that the agent:bootstrap hook strips AGENTS.md from worker sessions.
 *
 * Run: npx tsx --test lib/services/bootstrap.e2e.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { createTestHarness, type TestHarness } from "../testing/index.js";
import { dispatchTask } from "../dispatch/index.js";

describe("E2E bootstrap — extraSystemPrompt injection", () => {
  let h: TestHarness;

  afterEach(async () => {
    if (h) await h.cleanup();
  });

  it("should inject project-specific instructions via extraSystemPrompt", async () => {
    h = await createTestHarness({ projectName: "my-app" });
    h.provider.seedIssue({ iid: 1, title: "Add feature", labels: ["To Do"] });

    // Write both default and project-specific prompts
    await h.writePrompt("developer", "# Default Developer\nGeneric instructions.");
    await h.writePrompt("developer", "# My App Developer\nUse React. Follow our design system.", "my-app");

    await dispatchTask({
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
      runCommand: h.runCommand,
    });

    // Verify extraSystemPrompt in the gateway agent call
    const prompts = h.commands.extraSystemPrompts();
    assert.strictEqual(prompts.length, 1, `Expected 1 extraSystemPrompt, got ${prompts.length}`);
    assert.ok(prompts[0].includes("My App Developer"), `Got: ${prompts[0]}`);
    assert.ok(prompts[0].includes("Use React"));
    assert.ok(!prompts[0].includes("Generic instructions"));
  });

  it("should fall back to default instructions when no project override exists", async () => {
    h = await createTestHarness({ projectName: "other-app" });
    h.provider.seedIssue({ iid: 2, title: "Fix bug", labels: ["To Do"] });

    // Only write default prompt — no project-specific
    await h.writePrompt("developer", "# Default Developer\nFollow coding standards.");

    await dispatchTask({
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
      runCommand: h.runCommand,
    });

    const prompts = h.commands.extraSystemPrompts();
    assert.strictEqual(prompts.length, 1);
    assert.ok(prompts[0].includes("Default Developer"));
    assert.ok(prompts[0].includes("Follow coding standards"));
  });

  it("should inject scaffolded default instructions when no overrides exist", async () => {
    h = await createTestHarness({ projectName: "bare-app" });
    h.provider.seedIssue({ iid: 3, title: "Chore", labels: ["To Do"] });

    // Don't write any custom prompts — ensureWorkspaceMigrated scaffolds defaults

    await dispatchTask({
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
      runCommand: h.runCommand,
    });

    const prompts = h.commands.extraSystemPrompts();
    // No prompt files exist in this temp workspace — extraSystemPrompt should be absent
    assert.strictEqual(prompts.length, 0, "No extraSystemPrompt when no prompt files exist");
  });

  it("should resolve tester instructions independently from developer", async () => {
    h = await createTestHarness({ projectName: "multi-role" });
    h.provider.seedIssue({ iid: 4, title: "Test thing", labels: ["To Test"] });

    // Write project-specific for developer, default for tester
    await h.writePrompt("developer", "# Dev for multi-role\nSpecific dev rules.", "multi-role");
    await h.writePrompt("tester", "# Default Tester\nRun integration tests.");

    // Dispatch as tester
    await dispatchTask({
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
      runCommand: h.runCommand,
    });

    const prompts = h.commands.extraSystemPrompts();
    assert.strictEqual(prompts.length, 1);
    assert.ok(prompts[0].includes("Default Tester"));
    assert.ok(!prompts[0].includes("Dev for multi-role"));
  });

  it("should handle project names with hyphens correctly", async () => {
    h = await createTestHarness({ projectName: "my-cool-project" });
    h.provider.seedIssue({ iid: 5, title: "Hyphen test", labels: ["To Do"] });

    await h.writePrompt(
      "developer",
      "# Hyphenated Project\nThis project has hyphens in the name.",
      "my-cool-project",
    );

    await dispatchTask({
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
      runCommand: h.runCommand,
    });

    const prompts = h.commands.extraSystemPrompts();
    assert.strictEqual(prompts.length, 1);
    assert.ok(prompts[0].includes("Hyphenated Project"));
  });

  it("should resolve architect instructions with project override", async () => {
    h = await createTestHarness({ projectName: "arch-proj" });
    h.provider.seedIssue({ iid: 6, title: "Design API", labels: ["Planning"] });

    await h.writePrompt("architect", "# Default Architect\nGeneral design guidelines.");
    await h.writePrompt("architect", "# Arch Proj Architect\nUse event-driven architecture.", "arch-proj");

    await dispatchTask({
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
      runCommand: h.runCommand,
    });

    const prompts = h.commands.extraSystemPrompts();
    assert.strictEqual(prompts.length, 1);
    assert.ok(prompts[0].includes("Arch Proj Architect"));
    assert.ok(prompts[0].includes("event-driven"));
    assert.ok(!prompts[0].includes("General design guidelines"));
  });
});

describe("E2E bootstrap — agent:bootstrap hook (AGENTS.md stripping)", () => {
  let h: TestHarness;

  afterEach(async () => {
    if (h) await h.cleanup();
  });

  it("should strip AGENTS.md for DevClaw worker sessions", async () => {
    h = await createTestHarness({ projectName: "my-app" });

    const result = await h.simulateBootstrap(
      "agent:main:subagent:my-app-developer-medior-Ada",
    );
    assert.strictEqual(result.agentsMdStripped, true);
  });

  it("should NOT strip AGENTS.md for non-DevClaw sessions", async () => {
    h = await createTestHarness();

    const result = await h.simulateBootstrap("agent:main:orchestrator");
    assert.strictEqual(result.agentsMdStripped, false);
  });

  it("should NOT strip AGENTS.md for unknown roles", async () => {
    h = await createTestHarness({ projectName: "custom-app" });

    const result = await h.simulateBootstrap(
      "agent:main:subagent:custom-app-investigator-medior",
    );
    assert.strictEqual(result.agentsMdStripped, false);
  });
});
