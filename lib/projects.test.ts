/**
 * Tests for projects.ts session persistence
 * Run with: npm test
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  type ProjectsData,
  activateWorker,
  deactivateWorker,
  readProjects,
  writeProjects,
} from "./projects.js";

describe("Session persistence", () => {
  let tempDir: string;
  let testWorkspaceDir: string;

  before(async () => {
    // Create temp directory for test workspace
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-test-"));
    testWorkspaceDir = tempDir;
    await fs.mkdir(path.join(testWorkspaceDir, "memory"), { recursive: true });

    // Create initial projects.json
    const initialData: ProjectsData = {
      projects: {
        "-test-group": {
          name: "test-project",
          repo: "~/git/test-project",
          groupName: "Test Project",
          deployUrl: "https://test.example.com",
          baseBranch: "main",
          deployBranch: "main",
          autoChain: false,
          channel: "telegram",
          dev: {
            active: false,
            issueId: null,
            startTime: null,
            model: null,
            sessions: {
              junior: null,
              medior: null,
              senior: null,
            },
          },
          qa: {
            active: false,
            issueId: null,
            startTime: null,
            model: null,
            sessions: {
              qa: null,
            },
          },
        },
      },
    };
    await writeProjects(testWorkspaceDir, initialData);
  });

  after(async () => {
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should preserve sessions after task completion (single tier)", async () => {
    // Simulate task pickup: activate worker with senior tier
    await activateWorker(testWorkspaceDir, "-test-group", "dev", {
      issueId: "42",
      model: "senior",
      sessionKey: "agent:test:subagent:senior-session-123",
      startTime: new Date().toISOString(),
    });

    // Verify session was stored
    let data = await readProjects(testWorkspaceDir);
    assert.strictEqual(
      data.projects["-test-group"].dev.sessions.senior,
      "agent:test:subagent:senior-session-123",
      "Senior session should be stored after activation",
    );
    assert.strictEqual(
      data.projects["-test-group"].dev.active,
      true,
      "Worker should be active",
    );

    // Simulate task completion: deactivate worker
    await deactivateWorker(testWorkspaceDir, "-test-group", "dev");

    // Verify session persists after deactivation
    data = await readProjects(testWorkspaceDir);
    assert.strictEqual(
      data.projects["-test-group"].dev.sessions.senior,
      "agent:test:subagent:senior-session-123",
      "Senior session should persist after deactivation",
    );
    assert.strictEqual(
      data.projects["-test-group"].dev.active,
      false,
      "Worker should be inactive",
    );
    assert.strictEqual(
      data.projects["-test-group"].dev.issueId,
      null,
      "Issue ID should be cleared",
    );
  });

  it("should preserve all tier sessions after completion (multiple tiers)", async () => {
    // Setup: create sessions for multiple tiers
    await activateWorker(testWorkspaceDir, "-test-group", "dev", {
      issueId: "10",
      model: "junior",
      sessionKey: "agent:test:subagent:junior-session-111",
      startTime: new Date().toISOString(),
    });
    await deactivateWorker(testWorkspaceDir, "-test-group", "dev");

    await activateWorker(testWorkspaceDir, "-test-group", "dev", {
      issueId: "20",
      model: "medior",
      sessionKey: "agent:test:subagent:medior-session-222",
      startTime: new Date().toISOString(),
    });
    await deactivateWorker(testWorkspaceDir, "-test-group", "dev");

    await activateWorker(testWorkspaceDir, "-test-group", "dev", {
      issueId: "30",
      model: "senior",
      sessionKey: "agent:test:subagent:senior-session-333",
      startTime: new Date().toISOString(),
    });
    await deactivateWorker(testWorkspaceDir, "-test-group", "dev");

    // Verify all sessions persisted
    const data = await readProjects(testWorkspaceDir);
    assert.strictEqual(
      data.projects["-test-group"].dev.sessions.junior,
      "agent:test:subagent:junior-session-111",
      "Junior session should persist",
    );
    assert.strictEqual(
      data.projects["-test-group"].dev.sessions.medior,
      "agent:test:subagent:medior-session-222",
      "Medior session should persist",
    );
    assert.strictEqual(
      data.projects["-test-group"].dev.sessions.senior,
      "agent:test:subagent:senior-session-333",
      "Senior session should persist",
    );
  });

  it("should reuse existing session when picking up new task", async () => {
    // Setup: create a session for senior tier
    await activateWorker(testWorkspaceDir, "-test-group", "dev", {
      issueId: "100",
      model: "senior",
      sessionKey: "agent:test:subagent:senior-reuse-999",
      startTime: new Date().toISOString(),
    });
    await deactivateWorker(testWorkspaceDir, "-test-group", "dev");

    // Pick up new task with same tier (no sessionKey = reuse)
    await activateWorker(testWorkspaceDir, "-test-group", "dev", {
      issueId: "200",
      model: "senior",
    });

    // Verify session was preserved (not overwritten)
    const data = await readProjects(testWorkspaceDir);
    assert.strictEqual(
      data.projects["-test-group"].dev.sessions.senior,
      "agent:test:subagent:senior-reuse-999",
      "Senior session should be reused (not cleared)",
    );
    assert.strictEqual(
      data.projects["-test-group"].dev.issueId,
      "200",
      "Issue ID should be updated to new task",
    );
  });
});
