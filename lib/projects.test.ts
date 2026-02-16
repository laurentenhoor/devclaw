/**
 * Tests for projects.ts — worker state, migration, and accessors.
 * Run with: npx tsx --test lib/projects.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readProjects, getWorker, emptyWorkerState, writeProjects, type ProjectsData } from "./projects.js";

describe("readProjects migration", () => {
  it("should migrate old format (dev/qa/architect fields) to workers map", async () => {
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

    // Developer worker should be active with migrated level
    assert.strictEqual(project.workers.developer.active, true);
    assert.strictEqual(project.workers.developer.issueId, "42");
    assert.strictEqual(project.workers.developer.level, "medior");

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

    // Level names should be migrated (dev→developer, qa→tester, medior→medior, reviewer→medior)
    assert.strictEqual(project.workers.developer.level, "medior");
    assert.strictEqual(project.workers.tester.level, "medior");
    assert.strictEqual(project.workers.architect.level, "senior");

    // Session keys should be migrated
    assert.strictEqual(project.workers.developer.sessions.medior, "key-1");
    assert.strictEqual(project.workers.tester.sessions.medior, "key-2");
    assert.strictEqual(project.workers.architect.sessions.senior, "key-3");

    await fs.rm(tmpDir, { recursive: true });
  });

  it("should read new format (workers map) correctly", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-proj-"));
    const dataDir = path.join(tmpDir, "devclaw");
    await fs.mkdir(dataDir, { recursive: true });

    const newFormat = {
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
    await fs.writeFile(path.join(dataDir, "projects.json"), JSON.stringify(newFormat), "utf-8");

    const data = await readProjects(tmpDir);
    const project = data.projects["group-1"];

    assert.ok(project.workers.developer);
    assert.strictEqual(project.workers.developer.active, true);
    assert.strictEqual(project.workers.developer.level, "senior");
    assert.ok(project.workers.tester);

    await fs.rm(tmpDir, { recursive: true });
  });

  it("should migrate old worker keys in new format", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-proj-"));
    const dataDir = path.join(tmpDir, "devclaw");
    await fs.mkdir(dataDir, { recursive: true });

    // Workers map but with old role keys
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
    assert.strictEqual(project.workers.developer.level, "medior");
    assert.strictEqual(project.workers.developer.sessions.medior, "key-m");

    await fs.rm(tmpDir, { recursive: true });
  });
});

describe("getWorker", () => {
  it("should return worker from workers map", () => {
    const data: ProjectsData = {
      projects: {
        "g1": {
          name: "test",
          repo: "~/git/test",
          groupName: "Test",
          deployUrl: "",
          baseBranch: "main",
          deployBranch: "main",
          workers: {
            developer: { active: true, issueId: "5", startTime: null, level: "medior", sessions: {} },
          },
        },
      },
    };

    const worker = getWorker(data.projects["g1"], "developer");
    assert.strictEqual(worker.active, true);
    assert.strictEqual(worker.issueId, "5");
  });

  it("should return empty worker for unknown role", () => {
    const data: ProjectsData = {
      projects: {
        "g1": {
          name: "test",
          repo: "~/git/test",
          groupName: "Test",
          deployUrl: "",
          baseBranch: "main",
          deployBranch: "main",
          workers: {},
        },
      },
    };

    const worker = getWorker(data.projects["g1"], "nonexistent");
    assert.strictEqual(worker.active, false);
    assert.strictEqual(worker.issueId, null);
  });
});

describe("writeProjects round-trip", () => {
  it("should preserve workers map through write/read cycle", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-proj-"));
    const dataDir = path.join(tmpDir, "devclaw");
    await fs.mkdir(dataDir, { recursive: true });

    const data: ProjectsData = {
      projects: {
        "g1": {
          name: "roundtrip",
          repo: "~/git/rt",
          groupName: "RT",
          deployUrl: "",
          baseBranch: "main",
          deployBranch: "main",
          workers: {
            developer: emptyWorkerState(["junior", "medior", "senior"]),
            tester: emptyWorkerState(["junior", "medior", "senior"]),
            architect: emptyWorkerState(["junior", "senior"]),
          },
        },
      },
    };

    await writeProjects(tmpDir, data);
    const loaded = await readProjects(tmpDir);
    const project = loaded.projects["g1"];

    assert.ok(project.workers.developer);
    assert.ok(project.workers.tester);
    assert.ok(project.workers.architect);
    assert.strictEqual(project.workers.developer.sessions.junior, null);
    assert.strictEqual(project.workers.developer.sessions.medior, null);
    assert.strictEqual(project.workers.developer.sessions.senior, null);

    await fs.rm(tmpDir, { recursive: true });
  });
});
