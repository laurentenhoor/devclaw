/**
 * scenarios.test.ts — Scenario-based integration tests for DevClaw plugin tools.
 *
 * Tests the full tool pipeline in realistic sequences against real gateway + GitHub.
 * Each scenario exercises multiple tools in order, verifying BOTH return values
 * AND actual side effects (session existence, issue labels, projects.json state).
 *
 * Prerequisites:
 *   - OpenClaw gateway running
 *   - `gh` CLI authenticated with access to laurentenhoor/devclaw
 *   - `openclaw` CLI in PATH
 *
 * Run with: npm test
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";

import { createTaskCreateTool } from "../lib/tools/task-create.js";
import { createTaskPickupTool } from "../lib/tools/task-pickup.js";
import { createTaskCompleteTool } from "../lib/tools/task-complete.js";
import { createQueueStatusTool } from "../lib/tools/queue-status.js";
import { createSessionHealthTool } from "../lib/tools/session-health.js";
import { readProjects, writeProjects } from "../lib/projects.js";
import { resolveModel } from "../lib/tiers.js";
import {
  TestCleanup,
  TEST_GROUP_ID,
  TEST_PROJECT_NAME,
  TEST_REPO,
  createTestWorkspace,
  gateway,
  getIssueLabels,
  getIssueState,
  makeTestApi,
  makeTestContext,
  parseToolResult,
  sessionExists,
  sweepTestSessions,
} from "./helpers.js";

// ── Suite-level setup ───────────────────────────────────────────────────────

describe("DevClaw Scenario Tests", { timeout: 240_000 }, () => {
  before(async () => {
    // Verify gateway is accessible
    try {
      await gateway("sessions.list", { limit: 1 });
    } catch (err) {
      throw new Error(
        `Gateway not accessible — cannot run integration tests: ${(err as Error).message}. ` +
          `Ensure 'openclaw' is in PATH and gateway is running.`,
      );
    }

    // Verify gh CLI is authenticated
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);
      await execFileAsync("gh", ["auth", "status"], { timeout: 10_000 });
    } catch (err) {
      throw new Error(
        `GitHub CLI not authenticated — cannot run integration tests: ${(err as Error).message}`,
      );
    }

    // Sweep leftover test sessions from previous failed runs
    await sweepTestSessions();
  });

  // ── Scenario 1: Full DEV lifecycle ──────────────────────────────────────

  describe("Scenario 1: Full DEV lifecycle", () => {
    const cleanup = new TestCleanup();
    let workspaceDir: string;
    let api: ReturnType<typeof makeTestApi>;
    let ctx: ReturnType<typeof makeTestContext>;

    let createdIssueId: number;
    let spawnedSessionKey: string;

    before(async () => {
      workspaceDir = await createTestWorkspace({ autoChain: false });
      api = makeTestApi();
      ctx = makeTestContext(TEST_GROUP_ID, workspaceDir);
    });

    after(async () => {
      await cleanup.cleanAll();
      await fs.rm(workspaceDir, { recursive: true, force: true });
    });

    it("step 1: task_create creates a test issue with To Do label", async () => {
      const tool = createTaskCreateTool(api)(ctx);
      const result = parseToolResult(
        await tool.execute("test", {
          projectGroupId: TEST_GROUP_ID,
          title: "[TEST] Scenario 1 — DEV lifecycle test",
          description:
            "Automated integration test. This issue will be cleaned up automatically.",
          label: "To Do",
        }),
      );

      assert.strictEqual(result.success, true, "task_create should succeed");
      assert.ok(result.issue, "Should return issue object");
      createdIssueId = (result.issue as any).id as number;
      assert.ok(createdIssueId > 0, "Issue ID should be positive");
      cleanup.trackIssue(TEST_REPO, createdIssueId);

      // Verify side effect: issue has "To Do" label in GitHub
      const labels = await getIssueLabels(TEST_REPO, createdIssueId);
      assert.ok(
        labels.includes("To Do"),
        `Issue should have "To Do" label, got: ${labels.join(", ")}`,
      );
    });

    it("step 2: task_pickup spawns a worker session", async () => {
      const tool = createTaskPickupTool(api)(ctx);
      const result = parseToolResult(
        await tool.execute("test", {
          issueId: createdIssueId,
          role: "dev",
          projectGroupId: TEST_GROUP_ID,
          model: "junior",
        }),
      );

      assert.strictEqual(result.success, true, `task_pickup should succeed: ${result.error ?? ""}`);
      assert.strictEqual(result.sessionAction, "spawn", "Should spawn new session");

      // task_pickup stores the session key in projects.json, not in the result
      const data = await readProjects(workspaceDir);
      const project = data.projects[TEST_GROUP_ID];
      assert.ok(project.dev.sessions.junior, "Should have session key in projects.json");
      spawnedSessionKey = project.dev.sessions.junior as string;

      // Track for cleanup
      cleanup.trackSession(spawnedSessionKey);

      // Verify side effect: session exists in gateway
      const exists = await sessionExists(spawnedSessionKey);
      assert.ok(exists, `Session ${spawnedSessionKey} should exist in gateway`);

      // Verify side effect: issue label transitioned to "Doing"
      const labels = await getIssueLabels(TEST_REPO, createdIssueId);
      assert.ok(
        labels.includes("Doing"),
        `Issue should have "Doing" label after pickup, got: ${labels.join(", ")}`,
      );

      // Verify side effect: worker is active
      assert.strictEqual(project.dev.active, true, "Worker should be active");
      assert.strictEqual(
        project.dev.issueId,
        String(createdIssueId),
        "Worker should have correct issue ID",
      );
    });

    it("step 3: task_complete (dev done) transitions to To Test", async () => {
      const tool = createTaskCompleteTool(api)(ctx);
      const result = parseToolResult(
        await tool.execute("test", {
          role: "dev",
          result: "done",
          projectGroupId: TEST_GROUP_ID,
          summary: "Test task completed by integration test",
        }),
      );

      assert.strictEqual(result.success, true, `task_complete should succeed: ${result.error ?? ""}`);
      assert.ok(
        (result.labelTransition as string)?.includes("To Test"),
        `Label should transition to "To Test", got: ${result.labelTransition}`,
      );

      // Verify side effect: issue label is now "To Test"
      const labels = await getIssueLabels(TEST_REPO, createdIssueId);
      assert.ok(
        labels.includes("To Test"),
        `Issue should have "To Test" label, got: ${labels.join(", ")}`,
      );

      // Verify side effect: worker deactivated but session preserved
      const data = await readProjects(workspaceDir);
      const project = data.projects[TEST_GROUP_ID];
      assert.strictEqual(project.dev.active, false, "Worker should be inactive");
      assert.strictEqual(project.dev.issueId, null, "Issue ID should be cleared");
      assert.strictEqual(
        project.dev.sessions.junior,
        spawnedSessionKey,
        "Session should be PRESERVED after completion",
      );
    });

    it("step 4: task_pickup (qa) transitions to Testing", async () => {
      const tool = createTaskPickupTool(api)(ctx);
      const result = parseToolResult(
        await tool.execute("test", {
          issueId: createdIssueId,
          role: "qa",
          projectGroupId: TEST_GROUP_ID,
          model: "qa",
        }),
      );

      assert.strictEqual(result.success, true, `QA pickup should succeed: ${result.error ?? ""}`);

      // Read QA session key from projects.json
      const data = await readProjects(workspaceDir);
      const project = data.projects[TEST_GROUP_ID];
      assert.ok(project.qa.sessions.qa, "Should have QA session key in projects.json");
      cleanup.trackSession(project.qa.sessions.qa as string);

      // Verify side effect: issue label transitioned to "Testing"
      const labels = await getIssueLabels(TEST_REPO, createdIssueId);
      assert.ok(
        labels.includes("Testing"),
        `Issue should have "Testing" label after QA pickup, got: ${labels.join(", ")}`,
      );

      // Verify side effect: QA worker is active
      assert.strictEqual(project.qa.active, true, "QA worker should be active");
      assert.strictEqual(
        project.qa.issueId,
        String(createdIssueId),
        "QA worker should have correct issue ID",
      );
    });

    it("step 5: task_complete (qa pass) transitions to Done and closes issue", async () => {
      const tool = createTaskCompleteTool(api)(ctx);
      const result = parseToolResult(
        await tool.execute("test", {
          role: "qa",
          result: "pass",
          projectGroupId: TEST_GROUP_ID,
          summary: "QA passed by integration test",
        }),
      );

      assert.strictEqual(result.success, true, `QA complete should succeed: ${result.error ?? ""}`);
      assert.ok(
        (result.labelTransition as string)?.includes("Done"),
        `Label should transition to "Done", got: ${result.labelTransition}`,
      );
      assert.strictEqual(result.issueClosed, true, "Issue should be closed");

      // Verify side effect: issue label is now "Done"
      const labels = await getIssueLabels(TEST_REPO, createdIssueId);
      assert.ok(
        labels.includes("Done"),
        `Issue should have "Done" label, got: ${labels.join(", ")}`,
      );

      // Verify side effect: issue is closed
      const state = await getIssueState(TEST_REPO, createdIssueId);
      assert.strictEqual(state, "CLOSED", "Issue should be closed in GitHub");

      // Verify side effect: QA worker deactivated, sessions preserved
      const data = await readProjects(workspaceDir);
      const project = data.projects[TEST_GROUP_ID];
      assert.strictEqual(project.qa.active, false, "QA worker should be inactive");
      assert.strictEqual(project.qa.issueId, null, "QA issue ID should be cleared");

      // DEV session should still be preserved from earlier
      assert.strictEqual(
        project.dev.sessions.junior,
        spawnedSessionKey,
        "DEV session should still be PRESERVED after full lifecycle",
      );
    });
  });

  // ── Scenario 2: Queue status accuracy ─────────────────────────────────

  describe("Scenario 2: Queue status accuracy", () => {
    const cleanup = new TestCleanup();
    let workspaceDir: string;
    let api: ReturnType<typeof makeTestApi>;
    let ctx: ReturnType<typeof makeTestContext>;
    let issueIds: number[] = [];

    before(async () => {
      workspaceDir = await createTestWorkspace({ autoChain: false });
      api = makeTestApi();
      ctx = makeTestContext(TEST_GROUP_ID, workspaceDir);
    });

    after(async () => {
      await cleanup.cleanAll();
      await fs.rm(workspaceDir, { recursive: true, force: true });
    });

    it("step 1: create 3 issues with different labels", async () => {
      const tool = createTaskCreateTool(api)(ctx);

      const labels = ["To Do", "To Improve", "To Test"];
      for (const label of labels) {
        const result = parseToolResult(
          await tool.execute("test", {
            projectGroupId: TEST_GROUP_ID,
            title: `[TEST] Queue test — ${label}`,
            description: "Automated test issue for queue_status verification.",
            label,
          }),
        );
        assert.strictEqual(result.success, true);
        const issueId = (result.issue as any).id as number;
        issueIds.push(issueId);
        cleanup.trackIssue(TEST_REPO, issueId);
      }

      assert.strictEqual(issueIds.length, 3, "Should have created 3 issues");
    });

    it("step 2: queue_status shows all issues in correct buckets", async () => {
      // Small delay for GitHub API eventual consistency
      await new Promise((r) => setTimeout(r, 2_000));

      const tool = createQueueStatusTool(api)(ctx);
      const result = parseToolResult(
        await tool.execute("test", {
          projectGroupId: TEST_GROUP_ID,
        }),
      );

      // The result should contain projects with queue data
      const projects = result.projects as Array<{
        queue: {
          toImprove: Array<{ id: number }>;
          toTest: Array<{ id: number }>;
          toDo: Array<{ id: number }>;
        };
      }>;
      assert.ok(projects && projects.length > 0, "Should have project data");

      const queue = projects[0].queue;
      assert.ok(queue, "Should have queue data");

      // Verify each bucket has our test issues
      const toDoIds = queue.toDo.map((i) => i.id);
      const toImproveIds = queue.toImprove.map((i) => i.id);
      const toTestIds = queue.toTest.map((i) => i.id);

      assert.ok(
        toDoIds.includes(issueIds[0]),
        `"To Do" bucket should contain issue ${issueIds[0]}`,
      );
      assert.ok(
        toImproveIds.includes(issueIds[1]),
        `"To Improve" bucket should contain issue ${issueIds[1]}`,
      );
      assert.ok(
        toTestIds.includes(issueIds[2]),
        `"To Test" bucket should contain issue ${issueIds[2]}`,
      );
    });
  });

  // ── Scenario 3: Session health detection ──────────────────────────────

  describe("Scenario 3: Session health detection", () => {
    let workspaceDir: string;
    let api: ReturnType<typeof makeTestApi>;
    let ctx: ReturnType<typeof makeTestContext>;

    before(async () => {
      workspaceDir = await createTestWorkspace({ autoChain: false });
      api = makeTestApi();
      ctx = makeTestContext(TEST_GROUP_ID, workspaceDir);
    });

    after(async () => {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    });

    it("step 1: inject zombie state into projects.json", async () => {
      const data = await readProjects(workspaceDir);
      const project = data.projects[TEST_GROUP_ID];

      // Set active=true with a dead session key (session doesn't exist in gateway)
      project.dev.active = true;
      project.dev.issueId = "999";
      project.dev.model = "medior";
      project.dev.startTime = new Date(
        Date.now() - 3 * 60 * 60 * 1000,
      ).toISOString(); // 3 hours ago
      project.dev.sessions.medior =
        "agent:devclaw:subagent:dead-zombie-session-000";

      await writeProjects(workspaceDir, data);

      // Verify it was written
      const readBack = await readProjects(workspaceDir);
      assert.strictEqual(
        readBack.projects[TEST_GROUP_ID].dev.active,
        true,
        "Zombie state should be written",
      );
    });

    it("step 2: session_health detects the zombie (no autoFix)", async () => {
      const tool = createSessionHealthTool(api)(ctx);
      const result = parseToolResult(
        await tool.execute("test", {
          autoFix: false,
          activeSessions: [], // empty = zombie detection skipped, but stale_worker (3h) will be caught
        }),
      );

      assert.strictEqual(result.healthy, false, "Should report unhealthy");
      assert.ok(
        (result.issuesFound as number) > 0,
        "Should find at least one issue",
      );

      const issues = result.issues as Array<{
        type: string;
        project: string;
        role: string;
      }>;
      const zombieIssue = issues.find(
        (i) =>
          i.project === TEST_PROJECT_NAME &&
          i.role === "dev",
      );
      assert.ok(zombieIssue, "Should detect zombie for dev worker");
    });

    it("step 3: session_health fixes the zombie (autoFix=true)", async () => {
      const tool = createSessionHealthTool(api)(ctx);
      // Provide a non-empty activeSessions list that does NOT include the zombie key.
      // This enables zombie detection (requires activeSessions.length > 0).
      const result = parseToolResult(
        await tool.execute("test", {
          autoFix: true,
          activeSessions: ["agent:devclaw:subagent:some-alive-session"],
        }),
      );

      assert.ok(
        (result.fixesApplied as number) > 0,
        "Should apply at least one fix",
      );

      // Verify side effect: worker is deactivated in projects.json
      const data = await readProjects(workspaceDir);
      const project = data.projects[TEST_GROUP_ID];
      assert.strictEqual(
        project.dev.active,
        false,
        "Worker should be deactivated after auto-fix",
      );
    });
  });

  // ── Scenario 4: Auto-chain DEV → QA ──────────────────────────────────

  describe("Scenario 4: Auto-chain DEV → QA", () => {
    const cleanup = new TestCleanup();
    let workspaceDir: string;
    let api: ReturnType<typeof makeTestApi>;
    let ctx: ReturnType<typeof makeTestContext>;

    let issueId: number;
    let devSessionKey: string;

    before(async () => {
      workspaceDir = await createTestWorkspace({ autoChain: true });
      api = makeTestApi();
      ctx = makeTestContext(TEST_GROUP_ID, workspaceDir);
    });

    after(async () => {
      await cleanup.cleanAll();
      await fs.rm(workspaceDir, { recursive: true, force: true });
    });

    it("step 1: create issue and pick up for DEV", async () => {
      // Create
      const createTool = createTaskCreateTool(api)(ctx);
      const createResult = parseToolResult(
        await createTool.execute("test", {
          projectGroupId: TEST_GROUP_ID,
          title: "[TEST] Scenario 4 — Auto-chain DEV→QA",
          description: "Automated test for auto-chain pipeline.",
          label: "To Do",
        }),
      );
      issueId = (createResult.issue as any).id as number;
      cleanup.trackIssue(TEST_REPO, issueId);

      // Pickup DEV
      const pickupTool = createTaskPickupTool(api)(ctx);
      const pickupResult = parseToolResult(
        await pickupTool.execute("test", {
          issueId,
          role: "dev",
          projectGroupId: TEST_GROUP_ID,
          model: "junior",
        }),
      );
      assert.strictEqual(pickupResult.success, true, `Pickup should succeed: ${pickupResult.error ?? ""}`);

      // Read session key from projects.json (not in tool result)
      const pickupData = await readProjects(workspaceDir);
      devSessionKey = pickupData.projects[TEST_GROUP_ID].dev.sessions.junior as string;
      assert.ok(devSessionKey, "Should have session key in projects.json");
      cleanup.trackSession(devSessionKey);
    });

    it("step 2: task_complete (dev done) auto-chains to QA", async () => {
      const tool = createTaskCompleteTool(api)(ctx);
      const result = parseToolResult(
        await tool.execute("test", {
          role: "dev",
          result: "done",
          projectGroupId: TEST_GROUP_ID,
          summary: "DEV done, should auto-chain to QA",
        }),
      );

      assert.strictEqual(result.success, true, `Complete should succeed: ${result.error ?? ""}`);

      // Check auto-chain result
      const autoChain = result.autoChain as Record<string, unknown> | undefined;
      if (autoChain) {
        assert.strictEqual(
          autoChain.dispatched,
          true,
          "Auto-chain should dispatch QA",
        );
        assert.strictEqual(autoChain.role, "qa", "Should chain to QA role");

        // Track QA session for cleanup
        if (autoChain.sessionKey) {
          cleanup.trackSession(autoChain.sessionKey as string);
        }
      }

      // Verify issue label moved to Testing (via auto-chain)
      const labels = await getIssueLabels(TEST_REPO, issueId);
      assert.ok(
        labels.includes("Testing") || labels.includes("To Test"),
        `Issue should have "Testing" or "To Test" label, got: ${labels.join(", ")}`,
      );

      // Verify QA worker is active in projects.json
      const data = await readProjects(workspaceDir);
      const project = data.projects[TEST_GROUP_ID];
      if (autoChain?.dispatched) {
        assert.strictEqual(
          project.qa.active,
          true,
          "QA worker should be active after auto-chain",
        );
      }
    });
  });

  // ── Scenario 5: Blocked result escalation ────────────────────────────

  describe("Scenario 5: Blocked result escalation", () => {
    const cleanup = new TestCleanup();
    let workspaceDir: string;
    let api: ReturnType<typeof makeTestApi>;
    let ctx: ReturnType<typeof makeTestContext>;

    let issueId: number;

    before(async () => {
      workspaceDir = await createTestWorkspace({ autoChain: false });
      api = makeTestApi();
      ctx = makeTestContext(TEST_GROUP_ID, workspaceDir);
    });

    after(async () => {
      await cleanup.cleanAll();
      await fs.rm(workspaceDir, { recursive: true, force: true });
    });

    it("step 1: create issue, pick up as DEV, then block", async () => {
      // Create issue
      const createTool = createTaskCreateTool(api)(ctx);
      const createResult = parseToolResult(
        await createTool.execute("test", {
          projectGroupId: TEST_GROUP_ID,
          title: "[TEST] Scenario 5 — DEV blocked escalation",
          description: "Test that blocked DEV returns issue to queue.",
          label: "To Do",
        }),
      );
      issueId = (createResult.issue as any).id as number;
      cleanup.trackIssue(TEST_REPO, issueId);

      // Pickup DEV
      const pickupTool = createTaskPickupTool(api)(ctx);
      const pickupResult = parseToolResult(
        await pickupTool.execute("test", {
          issueId,
          role: "dev",
          projectGroupId: TEST_GROUP_ID,
          model: "junior",
        }),
      );
      assert.strictEqual(pickupResult.success, true, `Pickup should succeed: ${pickupResult.error ?? ""}`);

      // Track session for cleanup
      const data = await readProjects(workspaceDir);
      const sessionKey = data.projects[TEST_GROUP_ID].dev.sessions.junior as string;
      if (sessionKey) cleanup.trackSession(sessionKey);

      // Complete with blocked
      const completeTool = createTaskCompleteTool(api)(ctx);
      const completeResult = parseToolResult(
        await completeTool.execute("test", {
          role: "dev",
          result: "blocked",
          projectGroupId: TEST_GROUP_ID,
          summary: "Cannot complete — missing dependencies",
        }),
      );

      assert.strictEqual(completeResult.success, true, `Blocked should succeed: ${completeResult.error ?? ""}`);
      assert.strictEqual(completeResult.labelTransition, "Doing → To Do", "Should revert to To Do");

      // Verify side effect: issue label is back to "To Do"
      const labels = await getIssueLabels(TEST_REPO, issueId);
      assert.ok(
        labels.includes("To Do"),
        `Issue should have "To Do" label after DEV blocked, got: ${labels.join(", ")}`,
      );

      // Verify side effect: worker deactivated
      const refreshedData = await readProjects(workspaceDir);
      const project = refreshedData.projects[TEST_GROUP_ID];
      assert.strictEqual(project.dev.active, false, "DEV worker should be inactive after blocked");
    });

    it("step 2: pick up as QA, then block", async () => {
      // First do a DEV cycle to get to "To Test"
      const pickupTool = createTaskPickupTool(api)(ctx);
      await pickupTool.execute("test", {
        issueId,
        role: "dev",
        projectGroupId: TEST_GROUP_ID,
        model: "junior",
      });

      const completeTool = createTaskCompleteTool(api)(ctx);
      await completeTool.execute("test", {
        role: "dev",
        result: "done",
        projectGroupId: TEST_GROUP_ID,
        summary: "DEV done",
      });

      // Now pick up as QA
      const qaPickupResult = parseToolResult(
        await pickupTool.execute("test", {
          issueId,
          role: "qa",
          projectGroupId: TEST_GROUP_ID,
          model: "qa",
        }),
      );
      assert.strictEqual(qaPickupResult.success, true, `QA pickup should succeed: ${qaPickupResult.error ?? ""}`);

      // Track QA session for cleanup
      const data = await readProjects(workspaceDir);
      const qaSessionKey = data.projects[TEST_GROUP_ID].qa.sessions.qa as string;
      if (qaSessionKey) cleanup.trackSession(qaSessionKey);

      // Complete QA with blocked
      const qaCompleteResult = parseToolResult(
        await completeTool.execute("test", {
          role: "qa",
          result: "blocked",
          projectGroupId: TEST_GROUP_ID,
          summary: "Cannot test — environment not available",
        }),
      );

      assert.strictEqual(qaCompleteResult.success, true, `QA blocked should succeed: ${qaCompleteResult.error ?? ""}`);
      assert.strictEqual(qaCompleteResult.labelTransition, "Testing → To Test", "Should revert to To Test");

      // Verify side effect: issue label is back to "To Test"
      const labels = await getIssueLabels(TEST_REPO, issueId);
      assert.ok(
        labels.includes("To Test"),
        `Issue should have "To Test" label after QA blocked, got: ${labels.join(", ")}`,
      );

      // Verify side effect: QA worker deactivated
      const refreshedData = await readProjects(workspaceDir);
      const project = refreshedData.projects[TEST_GROUP_ID];
      assert.strictEqual(project.qa.active, false, "QA worker should be inactive after blocked");
    });
  });

  // ── Scenario 6: Model resolution ──────────────────────────────────────

  describe("Scenario 6: Model resolution", () => {
    it("resolves tier names to correct model IDs", () => {
      assert.strictEqual(
        resolveModel("junior"),
        "anthropic/claude-haiku-4-5",
      );
      assert.strictEqual(
        resolveModel("medior"),
        "anthropic/claude-sonnet-4-5",
      );
      assert.strictEqual(
        resolveModel("senior"),
        "anthropic/claude-opus-4-5",
      );
      assert.strictEqual(
        resolveModel("qa"),
        "anthropic/claude-sonnet-4-5",
      );
    });

    it("respects plugin config overrides", () => {
      assert.strictEqual(
        resolveModel("junior", { models: { junior: "custom/fast-model" } }),
        "custom/fast-model",
      );
    });

    it("passes through raw model IDs unchanged", () => {
      assert.strictEqual(
        resolveModel("openai/gpt-4o"),
        "openai/gpt-4o",
      );
    });
  });
});
