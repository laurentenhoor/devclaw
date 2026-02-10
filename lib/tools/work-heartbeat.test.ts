/**
 * Tests for work_heartbeat logic: project resolution, tick behavior, execution guards.
 *
 * Uses projectTick with dryRun: true to test the decision logic without
 * requiring OpenClaw API (sessions, dispatch). Mock providers simulate
 * issue queues; real projects.json fixtures simulate worker state.
 *
 * Run with: npx tsx --test lib/tools/work-heartbeat.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Project, WorkerState } from "../projects.js";
import { readProjects } from "../projects.js";
import { projectTick } from "../services/tick.js";
import type { StateLabel } from "../providers/provider.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const INACTIVE_WORKER: WorkerState = {
  active: false, issueId: null, startTime: null, level: null, sessions: {},
};

const ACTIVE_DEV: WorkerState = {
  active: true, issueId: "42", startTime: new Date().toISOString(), level: "medior",
  sessions: { medior: "session-dev-42" },
};

const ACTIVE_QA: WorkerState = {
  active: true, issueId: "42", startTime: new Date().toISOString(), level: "reviewer",
  sessions: { reviewer: "session-qa-42" },
};

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    name: "Test Project",
    repo: "https://github.com/test/repo",
    groupName: "Test Group",
    deployUrl: "",
    baseBranch: "main",
    deployBranch: "main",
    dev: { ...INACTIVE_WORKER },
    qa: { ...INACTIVE_WORKER },
    ...overrides,
  };
}

/** Minimal mock provider that returns pre-configured issues per label. */
function mockProvider(issuesByLabel: Partial<Record<StateLabel, Array<{ iid: number; title: string; description: string; labels: string[]; web_url: string; state: string }>>>) {
  return {
    listIssuesByLabel: async (label: string) => issuesByLabel[label as StateLabel] ?? [],
    getIssue: async () => { throw new Error("not implemented"); },
    transitionLabel: async () => {},
    getCurrentStateLabel: () => null,
  };
}

// ---------------------------------------------------------------------------
// Temp workspace helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

async function setupWorkspace(projects: Record<string, Project>): Promise<string> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-test-"));
  const projectsDir = path.join(tmpDir, "projects");
  await fs.mkdir(projectsDir, { recursive: true });
  await fs.writeFile(
    path.join(projectsDir, "projects.json"),
    JSON.stringify({ projects }, null, 2) + "\n",
    "utf-8",
  );
  return tmpDir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("work_heartbeat: project resolution", () => {
  afterEach(async () => { if (tmpDir) await fs.rm(tmpDir, { recursive: true }).catch(() => {}); });

  it("resolves all projects when no targetGroupId", async () => {
    // Given: two registered projects
    const workspaceDir = await setupWorkspace({
      "-100": makeProject({ name: "Alpha" }),
      "-200": makeProject({ name: "Beta" }),
    });

    const data = await readProjects(workspaceDir);
    const entries = Object.entries(data.projects);

    assert.strictEqual(entries.length, 2);
    assert.deepStrictEqual(entries.map(([, p]) => p.name).sort(), ["Alpha", "Beta"]);
  });

  it("resolves single project when targetGroupId given", async () => {
    const workspaceDir = await setupWorkspace({
      "-100": makeProject({ name: "Alpha" }),
      "-200": makeProject({ name: "Beta" }),
    });

    const data = await readProjects(workspaceDir);
    const project = data.projects["-100"];

    assert.ok(project);
    assert.strictEqual(project.name, "Alpha");
  });

  it("returns empty for unknown targetGroupId", async () => {
    const workspaceDir = await setupWorkspace({
      "-100": makeProject({ name: "Alpha" }),
    });

    const data = await readProjects(workspaceDir);
    assert.strictEqual(data.projects["-999"], undefined);
  });
});

describe("work_heartbeat: global state snapshot", () => {
  afterEach(async () => { if (tmpDir) await fs.rm(tmpDir, { recursive: true }).catch(() => {}); });

  it("counts active workers across projects", async () => {
    // Given: Alpha has active DEV, Beta has active QA, Gamma is idle
    const workspaceDir = await setupWorkspace({
      "-100": makeProject({ name: "Alpha", dev: { ...ACTIVE_DEV } }),
      "-200": makeProject({ name: "Beta", qa: { ...ACTIVE_QA } }),
      "-300": makeProject({ name: "Gamma" }),
    });

    const data = await readProjects(workspaceDir);
    let activeDev = 0, activeQa = 0, activeProjects = 0;
    for (const p of Object.values(data.projects)) {
      if (p.dev.active) activeDev++;
      if (p.qa.active) activeQa++;
      if (p.dev.active || p.qa.active) activeProjects++;
    }

    assert.strictEqual(activeDev, 1, "One active DEV worker (Alpha)");
    assert.strictEqual(activeQa, 1, "One active QA worker (Beta)");
    assert.strictEqual(activeProjects, 2, "Two projects have active workers");
  });
});

describe("work_heartbeat: priority ordering (dry run)", () => {
  afterEach(async () => { if (tmpDir) await fs.rm(tmpDir, { recursive: true }).catch(() => {}); });

  it("picks To Improve over To Do for dev", async () => {
    // Given: project with both "To Improve" and "To Do" issues
    // Expected: projectTick picks the To Improve issue (higher priority)
    const workspaceDir = await setupWorkspace({
      "-100": makeProject({ name: "Alpha", repo: "https://github.com/test/alpha" }),
    });

    // To Improve = fix failures (priority 1), To Do = new work (priority 3)
    // Priority order: To Improve > To Test > To Do
    const provider = mockProvider({
      "To Improve": [{ iid: 10, title: "Fix login bug", description: "", labels: ["To Improve"], web_url: "https://github.com/test/alpha/issues/10", state: "opened" }],
      "To Do": [{ iid: 20, title: "Add dark mode", description: "", labels: ["To Do"], web_url: "https://github.com/test/alpha/issues/20", state: "opened" }],
    });

    // projectTick with dryRun shows what would be picked up
    const result = await projectTick({
      workspaceDir, groupId: "-100", dryRun: true, provider,
    });

    // Should pick up #10 (To Improve) for dev, not #20 (To Do)
    const devPickup = result.pickups.find((p) => p.role === "dev");
    assert.ok(devPickup, "Should pick up a dev task");
    assert.strictEqual(devPickup.issueId, 10, "Should pick To Improve (#10) over To Do (#20)");
    assert.strictEqual(devPickup.announcement, "[DRY RUN] Would pick up #10");
  });

  it("picks To Test for qa role", async () => {
    // Given: project with "To Test" issue, QA slot free
    const workspaceDir = await setupWorkspace({
      "-100": makeProject({ name: "Alpha", repo: "https://github.com/test/alpha" }),
    });

    const provider = mockProvider({
      "To Test": [{ iid: 42, title: "Verify auth flow", description: "", labels: ["To Test"], web_url: "https://github.com/test/alpha/issues/42", state: "opened" }],
    });

    const result = await projectTick({
      workspaceDir, groupId: "-100", dryRun: true, provider,
    });

    const qaPickup = result.pickups.find((p) => p.role === "qa");
    assert.ok(qaPickup, "Should pick up a QA task");
    assert.strictEqual(qaPickup.issueId, 42);
    assert.strictEqual(qaPickup.role, "qa");
  });
});

describe("work_heartbeat: worker slot guards", () => {
  afterEach(async () => { if (tmpDir) await fs.rm(tmpDir, { recursive: true }).catch(() => {}); });

  it("skips role when worker already active", async () => {
    // Given: DEV worker active on #42, To Do issues in queue
    // Expected: skips DEV slot, only picks up QA if To Test available
    const workspaceDir = await setupWorkspace({
      "-100": makeProject({
        name: "Alpha",
        repo: "https://github.com/test/alpha",
        dev: { ...ACTIVE_DEV },
      }),
    });

    const provider = mockProvider({
      "To Do": [{ iid: 99, title: "New feature", description: "", labels: ["To Do"], web_url: "https://github.com/test/alpha/issues/99", state: "opened" }],
    });

    const result = await projectTick({
      workspaceDir, groupId: "-100", dryRun: true, provider,
    });

    // DEV already active → skipped, no To Test → QA skipped too
    assert.strictEqual(result.pickups.length, 0, "No pickups: DEV busy, no QA work");
    const devSkip = result.skipped.find((s) => s.role === "dev");
    assert.ok(devSkip, "Should have a skip reason for dev");
    assert.ok(devSkip.reason.includes("Already active"), "Skip reason should mention active worker");
  });

  it("fills both slots in parallel mode", async () => {
    // Given: parallel roleExecution (default), both DEV and QA slots free
    //        To Do issue + To Test issue available
    const workspaceDir = await setupWorkspace({
      "-100": makeProject({
        name: "Alpha",
        repo: "https://github.com/test/alpha",
        roleExecution: "parallel",
      }),
    });

    const provider = mockProvider({
      "To Do": [{ iid: 10, title: "Build API", description: "", labels: ["To Do"], web_url: "https://github.com/test/alpha/issues/10", state: "opened" }],
      "To Test": [{ iid: 20, title: "Verify API", description: "", labels: ["To Test"], web_url: "https://github.com/test/alpha/issues/20", state: "opened" }],
    });

    const result = await projectTick({
      workspaceDir, groupId: "-100", dryRun: true, provider,
    });

    // Both slots should be filled
    assert.strictEqual(result.pickups.length, 2, "Should pick up both DEV and QA");
    assert.ok(result.pickups.some((p) => p.role === "dev"), "Should have a dev pickup");
    assert.ok(result.pickups.some((p) => p.role === "qa"), "Should have a qa pickup");
  });

  it("respects sequential roleExecution", async () => {
    // Given: sequential roleExecution, DEV active on #42
    //        To Test issue available for QA
    // Expected: QA skipped because DEV is active (sequential = one role at a time)
    const workspaceDir = await setupWorkspace({
      "-100": makeProject({
        name: "Alpha",
        repo: "https://github.com/test/alpha",
        roleExecution: "sequential",
        dev: { ...ACTIVE_DEV },
      }),
    });

    const provider = mockProvider({
      "To Test": [{ iid: 20, title: "Verify fix", description: "", labels: ["To Test"], web_url: "https://github.com/test/alpha/issues/20", state: "opened" }],
    });

    const result = await projectTick({
      workspaceDir, groupId: "-100", dryRun: true, provider,
    });

    // DEV active + sequential → QA blocked
    assert.strictEqual(result.pickups.length, 0, "No pickups in sequential mode with active DEV");
    const qaSkip = result.skipped.find((s) => s.role === "qa");
    assert.ok(qaSkip, "Should skip QA");
    assert.ok(qaSkip.reason.includes("Sequential"), "Skip reason should mention sequential");
  });
});

describe("work_heartbeat: level assignment", () => {
  afterEach(async () => { if (tmpDir) await fs.rm(tmpDir, { recursive: true }).catch(() => {}); });

  it("uses label-based level when present", async () => {
    // Given: issue with "dev.senior" label → level should be "senior"
    const workspaceDir = await setupWorkspace({
      "-100": makeProject({ name: "Alpha", repo: "https://github.com/test/alpha" }),
    });

    const provider = mockProvider({
      "To Do": [{ iid: 10, title: "Refactor auth", description: "", labels: ["To Do", "dev.senior"], web_url: "https://github.com/test/alpha/issues/10", state: "opened" }],
    });

    const result = await projectTick({
      workspaceDir, groupId: "-100", dryRun: true, provider,
    });

    const pickup = result.pickups.find((p) => p.role === "dev");
    assert.ok(pickup);
    assert.strictEqual(pickup.level, "senior", "Should use label-based level");
  });

  it("overrides to reviewer level for qa role regardless of label", async () => {
    // Given: issue with "dev.senior" label but picked up by QA
    // Expected: level = "reviewer" (QA always uses reviewer level)
    const workspaceDir = await setupWorkspace({
      "-100": makeProject({ name: "Alpha", repo: "https://github.com/test/alpha" }),
    });

    const provider = mockProvider({
      "To Test": [{ iid: 10, title: "Review auth", description: "", labels: ["To Test", "dev.senior"], web_url: "https://github.com/test/alpha/issues/10", state: "opened" }],
    });

    const result = await projectTick({
      workspaceDir, groupId: "-100", dryRun: true, provider,
    });

    const qaPickup = result.pickups.find((p) => p.role === "qa");
    assert.ok(qaPickup);
    assert.strictEqual(qaPickup.level, "reviewer", "QA always uses reviewer level regardless of issue label");
  });

  it("falls back to heuristic when no level label", async () => {
    // Given: issue with no level label → heuristic selects based on title/description
    const workspaceDir = await setupWorkspace({
      "-100": makeProject({ name: "Alpha", repo: "https://github.com/test/alpha" }),
    });

    const provider = mockProvider({
      "To Do": [{ iid: 10, title: "Fix typo in README", description: "Simple typo fix", labels: ["To Do"], web_url: "https://github.com/test/alpha/issues/10", state: "opened" }],
    });

    const result = await projectTick({
      workspaceDir, groupId: "-100", dryRun: true, provider,
    });

    const pickup = result.pickups.find((p) => p.role === "dev");
    assert.ok(pickup);
    // Heuristic should select junior for a typo fix
    assert.strictEqual(pickup.level, "junior", "Heuristic should assign junior for simple typo fix");
  });
});

describe("work_heartbeat: maxPickups budget", () => {
  afterEach(async () => { if (tmpDir) await fs.rm(tmpDir, { recursive: true }).catch(() => {}); });

  it("respects maxPickups limit", async () => {
    // Given: both DEV and QA slots free, issues available for both
    //        maxPickups = 1
    // Expected: only one pickup
    const workspaceDir = await setupWorkspace({
      "-100": makeProject({ name: "Alpha", repo: "https://github.com/test/alpha" }),
    });

    const provider = mockProvider({
      "To Do": [{ iid: 10, title: "Feature A", description: "", labels: ["To Do"], web_url: "https://github.com/test/alpha/issues/10", state: "opened" }],
      "To Test": [{ iid: 20, title: "Review B", description: "", labels: ["To Test"], web_url: "https://github.com/test/alpha/issues/20", state: "opened" }],
    });

    const result = await projectTick({
      workspaceDir, groupId: "-100", dryRun: true, maxPickups: 1, provider,
    });

    assert.strictEqual(result.pickups.length, 1, "Should respect maxPickups=1");
  });
});

describe("work_heartbeat: TickAction output shape", () => {
  afterEach(async () => { if (tmpDir) await fs.rm(tmpDir, { recursive: true }).catch(() => {}); });

  it("includes all fields needed for notifications", async () => {
    // The TickAction must include issueUrl for workerStart notifications
    const workspaceDir = await setupWorkspace({
      "-100": makeProject({ name: "Alpha", repo: "https://github.com/test/alpha" }),
    });

    const provider = mockProvider({
      "To Do": [{ iid: 10, title: "Build feature", description: "Details here", labels: ["To Do"], web_url: "https://github.com/test/alpha/issues/10", state: "opened" }],
    });

    const result = await projectTick({
      workspaceDir, groupId: "-100", dryRun: true, provider,
    });

    const pickup = result.pickups[0];
    assert.ok(pickup, "Should have a pickup");

    // Verify all fields needed by notifyTickPickups
    assert.strictEqual(pickup.project, "Alpha");
    assert.strictEqual(pickup.groupId, "-100");
    assert.strictEqual(pickup.issueId, 10);
    assert.strictEqual(pickup.issueTitle, "Build feature");
    assert.strictEqual(pickup.issueUrl, "https://github.com/test/alpha/issues/10");
    assert.ok(["dev", "qa"].includes(pickup.role));
    assert.ok(typeof pickup.level === "string");
    assert.ok(["spawn", "send"].includes(pickup.sessionAction));
    assert.ok(pickup.announcement.includes("[DRY RUN]"));
  });
});
