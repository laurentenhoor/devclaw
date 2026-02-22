/**
 * Tests for projects.ts — per-level worker state, migration, and accessors.
 * Run with: npx tsx --test lib/projects.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  readProjects,
  getRoleWorker,
  emptyRoleWorkerState,
  emptySlot,
  findFreeSlot,
  findSlotByIssue,
  countActiveSlots,
  reconcileSlots,
  writeProjects,
  type ProjectsData,
  type RoleWorkerState,
} from "./projects.js";

describe("readProjects migration", () => {
  it("should migrate old format (dev/qa/architect fields) to per-level workers", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-proj-"));
    const projDir = path.join(tmpDir, "projects");
    await fs.mkdir(projDir, { recursive: true });

    // Old format: hardcoded dev/qa/architect fields
    const oldFormat = {
      projects: {
        "group-1": {
          name: "test-project",
          repo: "~/git/test",
          groupName: "Test",
          deployUrl: "",
          baseBranch: "main",
          deployBranch: "main",
          dev: { active: true, issueId: "42", startTime: null, level: "mid", sessions: { mid: "key-1" } },
          qa: { active: false, issueId: null, startTime: null, level: null, sessions: {} },
          architect: { active: false, issueId: null, startTime: null, level: null, sessions: {} },
        },
      },
    };
    await fs.writeFile(path.join(projDir, "projects.json"), JSON.stringify(oldFormat), "utf-8");

    const data = await readProjects(tmpDir);
    const project = data.projects["group-1"];

    // Should have workers map with migrated role keys
    assert.ok(project.workers, "should have workers map");
    assert.ok(project.workers.developer, "should have developer worker (migrated from dev)");
    assert.ok(project.workers.tester, "should have tester worker (migrated from qa)");
    assert.ok(project.workers.architect, "should have architect worker");

    // Developer worker should have levels.medior[0] active with migrated data
    const devRw = project.workers.developer;
    assert.ok(devRw.levels.medior, "should have medior level");
    assert.strictEqual(devRw.levels.medior[0]!.active, true);
    assert.strictEqual(devRw.levels.medior[0]!.issueId, "42");
    assert.strictEqual(devRw.levels.medior[0]!.sessionKey, "key-1");

    // Old fields should not exist on the object
    assert.strictEqual((project as any).dev, undefined);
    assert.strictEqual((project as any).qa, undefined);
    assert.strictEqual((project as any).architect, undefined);

    await fs.rm(tmpDir, { recursive: true });
  });

  it("should migrate old level names in old format", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-proj-"));
    const projDir = path.join(tmpDir, "projects");
    await fs.mkdir(projDir, { recursive: true });

    const oldFormat = {
      projects: {
        "group-1": {
          name: "legacy",
          repo: "~/git/legacy",
          groupName: "Legacy",
          deployUrl: "",
          baseBranch: "main",
          deployBranch: "main",
          dev: { active: false, issueId: null, startTime: null, level: "medior", sessions: { medior: "key-1" } },
          qa: { active: false, issueId: null, startTime: null, level: "reviewer", sessions: { reviewer: "key-2" } },
          architect: { active: false, issueId: null, startTime: null, level: "opus", sessions: { opus: "key-3" } },
        },
      },
    };
    await fs.writeFile(path.join(projDir, "projects.json"), JSON.stringify(oldFormat), "utf-8");

    const data = await readProjects(tmpDir);
    const project = data.projects["group-1"];

    // Level names should be migrated — "medior" stays, "reviewer" → "medior", "opus" → "senior"
    assert.ok(project.workers.developer.levels.medior, "developer should have medior level");
    assert.strictEqual(project.workers.developer.levels.medior[0]!.sessionKey, "key-1");
    assert.ok(project.workers.tester.levels.medior, "tester should have medior level (reviewer→medior)");
    assert.strictEqual(project.workers.tester.levels.medior[0]!.sessionKey, "key-2");
    assert.ok(project.workers.architect.levels.senior, "architect should have senior level (opus→senior)");
    assert.strictEqual(project.workers.architect.levels.senior[0]!.sessionKey, "key-3");

    await fs.rm(tmpDir, { recursive: true });
  });

  it("should read legacy workers-map format and migrate to per-level", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-proj-"));
    const dataDir = path.join(tmpDir, "devclaw");
    await fs.mkdir(dataDir, { recursive: true });

    // Old workers-map format (flat WorkerState, no slots)
    const legacyFormat = {
      projects: {
        "group-1": {
          name: "modern",
          repo: "~/git/modern",
          groupName: "Modern",
          deployUrl: "",
          baseBranch: "main",
          deployBranch: "main",
          workers: {
            developer: { active: true, issueId: "10", startTime: null, level: "senior", sessions: { senior: "key-s" } },
            tester: { active: false, issueId: null, startTime: null, level: null, sessions: {} },
          },
        },
      },
    };
    await fs.writeFile(path.join(dataDir, "projects.json"), JSON.stringify(legacyFormat), "utf-8");

    const data = await readProjects(tmpDir);
    const project = data.projects["group-1"];

    assert.ok(project.workers.developer);
    assert.ok(project.workers.developer.levels.senior, "should have senior level");
    assert.strictEqual(project.workers.developer.levels.senior[0]!.active, true);
    assert.strictEqual(project.workers.developer.levels.senior[0]!.sessionKey, "key-s");
    assert.ok(project.workers.tester);

    await fs.rm(tmpDir, { recursive: true });
  });

  it("should read old slot-based format and migrate to per-level", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-proj-"));
    const dataDir = path.join(tmpDir, "devclaw");
    await fs.mkdir(dataDir, { recursive: true });

    const slotFormat = {
      projects: {
        "g1": {
          slug: "test",
          name: "test",
          repo: "~/git/test",
          groupName: "Test",
          deployUrl: "",
          baseBranch: "main",
          deployBranch: "main",
          channels: [{ groupId: "g1", channel: "telegram", name: "primary", events: ["*"] }],
          workers: {
            developer: {
              maxWorkers: 2,
              slots: [
                { active: true, issueId: "5", level: "medior", sessionKey: "key-1", startTime: "2026-01-01T00:00:00Z" },
                { active: false, issueId: null, level: null, sessionKey: null, startTime: null },
              ],
            },
          },
        },
      },
    };
    await fs.writeFile(path.join(dataDir, "projects.json"), JSON.stringify(slotFormat), "utf-8");

    const data = await readProjects(tmpDir);
    const rw = data.projects["g1"].workers.developer;

    // Slot with level "medior" should be in levels.medior
    assert.ok(rw.levels.medior, "should have medior level");
    assert.strictEqual(rw.levels.medior[0]!.active, true);
    assert.strictEqual(rw.levels.medior[0]!.issueId, "5");
    // Slot with null level should be dropped (no "unknown" fallback)

    await fs.rm(tmpDir, { recursive: true });
  });

  it("should read new per-level format correctly", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-proj-"));
    const dataDir = path.join(tmpDir, "devclaw");
    await fs.mkdir(dataDir, { recursive: true });

    const levelFormat = {
      projects: {
        "g1": {
          slug: "test",
          name: "test",
          repo: "~/git/test",
          groupName: "Test",
          deployUrl: "",
          baseBranch: "main",
          deployBranch: "main",
          channels: [{ groupId: "g1", channel: "telegram", name: "primary", events: ["*"] }],
          workers: {
            developer: {
              levels: {
                medior: [
                  { active: true, issueId: "5", sessionKey: "key-1", startTime: "2026-01-01T00:00:00Z" },
                  { active: false, issueId: null, sessionKey: null, startTime: null },
                ],
              },
            },
          },
        },
      },
    };
    await fs.writeFile(path.join(dataDir, "projects.json"), JSON.stringify(levelFormat), "utf-8");

    const data = await readProjects(tmpDir);
    const rw = data.projects["g1"].workers.developer;

    assert.ok(rw.levels.medior, "should have medior level");
    assert.strictEqual(rw.levels.medior.length, 2);
    assert.strictEqual(rw.levels.medior[0]!.active, true);
    assert.strictEqual(rw.levels.medior[0]!.issueId, "5");
    assert.strictEqual(rw.levels.medior[1]!.active, false);

    await fs.rm(tmpDir, { recursive: true });
  });

  it("should migrate old worker keys in workers-map format", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-proj-"));
    const dataDir = path.join(tmpDir, "devclaw");
    await fs.mkdir(dataDir, { recursive: true });

    const mixedFormat = {
      projects: {
        "group-1": {
          name: "mixed",
          repo: "~/git/mixed",
          groupName: "Mixed",
          deployUrl: "",
          baseBranch: "main",
          deployBranch: "main",
          workers: {
            dev: { active: true, issueId: "10", startTime: null, level: "mid", sessions: { mid: "key-m" } },
            qa: { active: false, issueId: null, startTime: null, level: null, sessions: {} },
          },
        },
      },
    };
    await fs.writeFile(path.join(dataDir, "projects.json"), JSON.stringify(mixedFormat), "utf-8");

    const data = await readProjects(tmpDir);
    const project = data.projects["group-1"];

    // Old keys should be migrated
    assert.ok(project.workers.developer, "dev should be migrated to developer");
    assert.ok(project.workers.tester, "qa should be migrated to tester");
    assert.ok(project.workers.developer.levels.medior, "mid should be migrated to medior");
    assert.strictEqual(project.workers.developer.levels.medior[0]!.sessionKey, "key-m");

    await fs.rm(tmpDir, { recursive: true });
  });
});

describe("per-level slot helpers", () => {
  it("findFreeSlot returns lowest inactive slot within a level", () => {
    const rw: RoleWorkerState = {
      levels: {
        medior: [
          { active: true, issueId: "1", sessionKey: null, startTime: null },
          { active: false, issueId: null, sessionKey: null, startTime: null },
          { active: false, issueId: null, sessionKey: null, startTime: null },
        ],
      },
    };
    assert.strictEqual(findFreeSlot(rw, "medior"), 1);
  });

  it("findFreeSlot returns null when all active in the level", () => {
    const rw: RoleWorkerState = {
      levels: {
        medior: [{ active: true, issueId: "1", sessionKey: null, startTime: null }],
      },
    };
    assert.strictEqual(findFreeSlot(rw, "medior"), null);
  });

  it("findFreeSlot returns null for non-existent level", () => {
    const rw: RoleWorkerState = { levels: {} };
    assert.strictEqual(findFreeSlot(rw, "senior"), null);
  });

  it("findSlotByIssue returns correct level and index", () => {
    const rw: RoleWorkerState = {
      levels: {
        medior: [
          { active: true, issueId: "10", sessionKey: null, startTime: null },
        ],
        junior: [
          { active: true, issueId: "20", sessionKey: null, startTime: null },
        ],
      },
    };
    const result = findSlotByIssue(rw, "20");
    assert.deepStrictEqual(result, { level: "junior", slotIndex: 0 });
    assert.strictEqual(findSlotByIssue(rw, "99"), null);
  });

  it("countActiveSlots counts across all levels", () => {
    const rw: RoleWorkerState = {
      levels: {
        medior: [
          { active: true, issueId: "1", sessionKey: null, startTime: null },
          { active: false, issueId: null, sessionKey: null, startTime: null },
        ],
        junior: [
          { active: true, issueId: "3", sessionKey: null, startTime: null },
        ],
      },
    };
    assert.strictEqual(countActiveSlots(rw), 2);
  });
});

describe("writeProjects round-trip", () => {
  it("should preserve per-level workers through write/read cycle", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-proj-"));
    const dataDir = path.join(tmpDir, "devclaw");
    await fs.mkdir(dataDir, { recursive: true });

    const data: ProjectsData = {
      projects: {
        "g1": {
          slug: "roundtrip",
          name: "roundtrip",
          repo: "~/git/rt",
          groupName: "RT",
          deployUrl: "",
          baseBranch: "main",
          deployBranch: "main",
          channels: [{ groupId: "g1", channel: "telegram", name: "primary", events: ["*"] }],
          workers: {
            developer: emptyRoleWorkerState({ medior: 2 }),
            tester: emptyRoleWorkerState({ medior: 1 }),
            architect: emptyRoleWorkerState({ senior: 1 }),
          },
        },
      },
    };

    await writeProjects(tmpDir, data);
    const loaded = await readProjects(tmpDir);
    const project = loaded.projects["g1"];

    assert.ok(project.workers.developer);
    assert.ok(project.workers.developer.levels.medior);
    assert.strictEqual(project.workers.developer.levels.medior.length, 2);
    assert.strictEqual(project.workers.developer.levels.medior[0]!.active, false);
    assert.strictEqual(project.workers.developer.levels.medior[1]!.active, false);

    await fs.rm(tmpDir, { recursive: true });
  });
});

describe("reconcileSlots", () => {
  it("should expand slots when config increases maxWorkers for a level", () => {
    const rw: RoleWorkerState = {
      levels: { medior: [emptySlot()] },
    };
    const changed = reconcileSlots(rw, { medior: 3 });
    assert.strictEqual(changed, true);
    assert.strictEqual(rw.levels.medior.length, 3);
    assert.strictEqual(rw.levels.medior[1]!.active, false);
    assert.strictEqual(rw.levels.medior[2]!.active, false);
  });

  it("should shrink idle slots when config decreases maxWorkers", () => {
    const rw: RoleWorkerState = {
      levels: { medior: [emptySlot(), emptySlot(), emptySlot()] },
    };
    const changed = reconcileSlots(rw, { medior: 1 });
    assert.strictEqual(changed, true);
    assert.strictEqual(rw.levels.medior.length, 1);
  });

  it("should not remove active slots when shrinking", () => {
    const rw: RoleWorkerState = {
      levels: {
        medior: [
          { active: true, issueId: "1", sessionKey: null, startTime: null },
          { active: false, issueId: null, sessionKey: null, startTime: null },
          { active: true, issueId: "3", sessionKey: null, startTime: null },
        ],
      },
    };
    // Config says 1, but last slot (index 2) is active — shrinking stops immediately
    const changed = reconcileSlots(rw, { medior: 1 });
    assert.strictEqual(changed, false);
    assert.strictEqual(rw.levels.medior.length, 3);
  });

  it("should remove trailing idle slots but stop at active ones", () => {
    const rw: RoleWorkerState = {
      levels: {
        medior: [
          { active: true, issueId: "1", sessionKey: null, startTime: null },
          { active: true, issueId: "2", sessionKey: null, startTime: null },
          { active: false, issueId: null, sessionKey: null, startTime: null },
        ],
      },
    };
    // Config says 1, last slot (index 2) is idle → removed, then slot 1 is active → stop
    const changed = reconcileSlots(rw, { medior: 1 });
    assert.strictEqual(changed, true);
    assert.strictEqual(rw.levels.medior.length, 2);
  });

  it("should not change when slots match config", () => {
    const rw: RoleWorkerState = {
      levels: { medior: [emptySlot(), emptySlot()] },
    };
    const changed = reconcileSlots(rw, { medior: 2 });
    assert.strictEqual(changed, false);
    assert.strictEqual(rw.levels.medior.length, 2);
  });

  it("should create new level arrays for levels in config but not in state", () => {
    const rw: RoleWorkerState = { levels: {} };
    const changed = reconcileSlots(rw, { medior: 2, senior: 1 });
    assert.strictEqual(changed, true);
    assert.strictEqual(rw.levels.medior.length, 2);
    assert.strictEqual(rw.levels.senior.length, 1);
  });
});
