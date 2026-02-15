/**
 * Tests for workspace layout migration.
 * Run with: npx tsx --test lib/setup/migrate-layout.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { migrateWorkspaceLayout } from "./migrate-layout.js";

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

describe("migrateWorkspaceLayout — very old layout → devclaw/", () => {
  it("should move projects/projects.json to devclaw/projects.json", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-migrate-"));
    const projDir = path.join(tmpDir, "projects");
    await fs.mkdir(projDir, { recursive: true });
    await fs.writeFile(path.join(projDir, "projects.json"), '{"projects":{}}');

    await migrateWorkspaceLayout(tmpDir);

    assert.ok(await fileExists(path.join(tmpDir, "devclaw", "projects.json")), "projects.json should be at devclaw/");
    assert.ok(!await fileExists(path.join(projDir, "projects.json")), "old projects.json should be removed");

    await fs.rm(tmpDir, { recursive: true });
  });

  it("should rename projects/config.yaml to devclaw/workflow.yaml", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-migrate-"));
    const projDir = path.join(tmpDir, "projects");
    await fs.mkdir(projDir, { recursive: true });
    await fs.writeFile(path.join(projDir, "projects.json"), '{"projects":{}}');
    await fs.writeFile(path.join(projDir, "config.yaml"), "roles:\n  dev:\n    defaultLevel: medior\n");

    await migrateWorkspaceLayout(tmpDir);

    assert.ok(await fileExists(path.join(tmpDir, "devclaw", "workflow.yaml")), "workflow.yaml should be at devclaw/");
    assert.ok(!await fileExists(path.join(projDir, "config.yaml")), "old config.yaml should be removed");
    const content = await fs.readFile(path.join(tmpDir, "devclaw", "workflow.yaml"), "utf-8");
    assert.ok(content.includes("defaultLevel: medior"), "content should be preserved");

    await fs.rm(tmpDir, { recursive: true });
  });

  it("should move roles/default/* to devclaw/prompts/ with renames", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-migrate-"));
    const projDir = path.join(tmpDir, "projects");
    const defaultDir = path.join(projDir, "roles", "default");
    await fs.mkdir(defaultDir, { recursive: true });
    await fs.writeFile(path.join(projDir, "projects.json"), '{"projects":{}}');
    await fs.writeFile(path.join(defaultDir, "dev.md"), "# Dev instructions");
    await fs.writeFile(path.join(defaultDir, "qa.md"), "# QA instructions");
    await fs.writeFile(path.join(defaultDir, "architect.md"), "# Architect instructions");

    await migrateWorkspaceLayout(tmpDir);

    assert.ok(await fileExists(path.join(tmpDir, "devclaw", "prompts", "developer.md")), "dev.md should become developer.md");
    assert.ok(await fileExists(path.join(tmpDir, "devclaw", "prompts", "tester.md")), "qa.md should become tester.md");
    assert.ok(await fileExists(path.join(tmpDir, "devclaw", "prompts", "architect.md")), "architect.md should stay");

    const devContent = await fs.readFile(path.join(tmpDir, "devclaw", "prompts", "developer.md"), "utf-8");
    assert.strictEqual(devContent, "# Dev instructions");

    assert.ok(!await fileExists(defaultDir), "old default dir should be removed");

    await fs.rm(tmpDir, { recursive: true });
  });

  it("should move roles/<project>/* to devclaw/projects/<project>/prompts/ with renames", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-migrate-"));
    const projDir = path.join(tmpDir, "projects");
    const roleDir = path.join(projDir, "roles", "my-app");
    await fs.mkdir(roleDir, { recursive: true });
    await fs.writeFile(path.join(projDir, "projects.json"), '{"projects":{}}');
    await fs.writeFile(path.join(roleDir, "dev.md"), "# My App Developer");
    await fs.writeFile(path.join(roleDir, "qa.md"), "# My App Tester");
    await fs.writeFile(path.join(roleDir, "architect.md"), "# My App Architect");

    await migrateWorkspaceLayout(tmpDir);

    assert.ok(await fileExists(path.join(tmpDir, "devclaw", "projects", "my-app", "prompts", "developer.md")), "dev.md should become prompts/developer.md");
    assert.ok(await fileExists(path.join(tmpDir, "devclaw", "projects", "my-app", "prompts", "tester.md")), "qa.md should become prompts/tester.md");
    assert.ok(await fileExists(path.join(tmpDir, "devclaw", "projects", "my-app", "prompts", "architect.md")), "architect.md should be in prompts/");

    const content = await fs.readFile(path.join(tmpDir, "devclaw", "projects", "my-app", "prompts", "developer.md"), "utf-8");
    assert.strictEqual(content, "# My App Developer");

    await fs.rm(tmpDir, { recursive: true });
  });

  it("should rename projects/<project>/config.yaml to devclaw/projects/<project>/workflow.yaml", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-migrate-"));
    const projDir = path.join(tmpDir, "projects");
    const appDir = path.join(projDir, "my-app");
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(path.join(projDir, "projects.json"), '{"projects":{}}');
    await fs.writeFile(path.join(appDir, "config.yaml"), "roles:\n  dev:\n    defaultLevel: senior\n");

    await migrateWorkspaceLayout(tmpDir);

    assert.ok(await fileExists(path.join(tmpDir, "devclaw", "projects", "my-app", "workflow.yaml")), "workflow.yaml should exist");
    assert.ok(!await fileExists(path.join(appDir, "config.yaml")), "old config.yaml should be removed");

    await fs.rm(tmpDir, { recursive: true });
  });

  it("should move log/ to devclaw/log/", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-migrate-"));
    const projDir = path.join(tmpDir, "projects");
    const logDir = path.join(tmpDir, "log");
    await fs.mkdir(projDir, { recursive: true });
    await fs.mkdir(logDir, { recursive: true });
    await fs.writeFile(path.join(projDir, "projects.json"), '{"projects":{}}');
    await fs.writeFile(path.join(logDir, "audit.log"), '{"ts":"2024-01-01"}');

    await migrateWorkspaceLayout(tmpDir);

    assert.ok(await fileExists(path.join(tmpDir, "devclaw", "log", "audit.log")), "audit.log should be in devclaw/log/");
    assert.ok(!await fileExists(path.join(logDir, "audit.log")), "old audit.log should be removed");

    await fs.rm(tmpDir, { recursive: true });
  });
});

describe("migrateWorkspaceLayout — intermediate layout → devclaw/", () => {
  it("should move projects.json from root to devclaw/", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-migrate-"));
    await fs.writeFile(path.join(tmpDir, "projects.json"), '{"projects":{}}');

    await migrateWorkspaceLayout(tmpDir);

    assert.ok(await fileExists(path.join(tmpDir, "devclaw", "projects.json")), "projects.json should be in devclaw/");
    assert.ok(!await fileExists(path.join(tmpDir, "projects.json")), "root projects.json should be removed");

    await fs.rm(tmpDir, { recursive: true });
  });

  it("should move workflow.yaml from root to devclaw/", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-migrate-"));
    await fs.writeFile(path.join(tmpDir, "projects.json"), '{"projects":{}}');
    await fs.writeFile(path.join(tmpDir, "workflow.yaml"), "roles:\n  dev:\n    defaultLevel: medior\n");

    await migrateWorkspaceLayout(tmpDir);

    assert.ok(await fileExists(path.join(tmpDir, "devclaw", "workflow.yaml")), "workflow.yaml should be in devclaw/");
    assert.ok(!await fileExists(path.join(tmpDir, "workflow.yaml")), "root workflow.yaml should be removed");

    await fs.rm(tmpDir, { recursive: true });
  });

  it("should move prompts/ from root to devclaw/prompts/", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-migrate-"));
    const promptsDir = path.join(tmpDir, "prompts");
    await fs.mkdir(promptsDir, { recursive: true });
    await fs.writeFile(path.join(tmpDir, "projects.json"), '{"projects":{}}');
    await fs.writeFile(path.join(promptsDir, "developer.md"), "# Dev");

    await migrateWorkspaceLayout(tmpDir);

    assert.ok(await fileExists(path.join(tmpDir, "devclaw", "prompts", "developer.md")), "developer.md should be in devclaw/prompts/");
    assert.ok(!await fileExists(path.join(promptsDir, "developer.md")), "old prompts/developer.md should be removed");

    await fs.rm(tmpDir, { recursive: true });
  });

  it("should move project .md files into prompts/ subdir", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-migrate-"));
    const projectDir = path.join(tmpDir, "projects", "my-app");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(tmpDir, "projects.json"), '{"projects":{}}');
    await fs.writeFile(path.join(projectDir, "developer.md"), "# My App Dev");
    await fs.writeFile(path.join(projectDir, "workflow.yaml"), "roles: {}");

    await migrateWorkspaceLayout(tmpDir);

    assert.ok(await fileExists(path.join(tmpDir, "devclaw", "projects", "my-app", "prompts", "developer.md")), "developer.md should be in prompts/ subdir");
    assert.ok(await fileExists(path.join(tmpDir, "devclaw", "projects", "my-app", "workflow.yaml")), "workflow.yaml should stay at project root");

    await fs.rm(tmpDir, { recursive: true });
  });

  it("should rename old role files (dev.md, qa.md) in prompts/", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-migrate-"));
    const promptsDir = path.join(tmpDir, "prompts");
    await fs.mkdir(promptsDir, { recursive: true });
    await fs.writeFile(path.join(tmpDir, "projects.json"), '{"projects":{}}');
    await fs.writeFile(path.join(promptsDir, "dev.md"), "# Old Dev");
    await fs.writeFile(path.join(promptsDir, "qa.md"), "# Old QA");

    await migrateWorkspaceLayout(tmpDir);

    assert.ok(await fileExists(path.join(tmpDir, "devclaw", "prompts", "developer.md")), "dev.md should become developer.md");
    assert.ok(await fileExists(path.join(tmpDir, "devclaw", "prompts", "tester.md")), "qa.md should become tester.md");

    await fs.rm(tmpDir, { recursive: true });
  });

  it("should rename old role files in project prompts/", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-migrate-"));
    const projectDir = path.join(tmpDir, "projects", "my-app");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(tmpDir, "projects.json"), '{"projects":{}}');
    await fs.writeFile(path.join(projectDir, "dev.md"), "# My App Dev");
    await fs.writeFile(path.join(projectDir, "qa.md"), "# My App QA");

    await migrateWorkspaceLayout(tmpDir);

    assert.ok(await fileExists(path.join(tmpDir, "devclaw", "projects", "my-app", "prompts", "developer.md")), "dev.md should become prompts/developer.md");
    assert.ok(await fileExists(path.join(tmpDir, "devclaw", "projects", "my-app", "prompts", "tester.md")), "qa.md should become prompts/tester.md");

    await fs.rm(tmpDir, { recursive: true });
  });

  it("should move log/ from root to devclaw/log/", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-migrate-"));
    const logDir = path.join(tmpDir, "log");
    await fs.mkdir(logDir, { recursive: true });
    await fs.writeFile(path.join(tmpDir, "projects.json"), '{"projects":{}}');
    await fs.writeFile(path.join(logDir, "audit.log"), '{"ts":"2024-01-01"}');

    await migrateWorkspaceLayout(tmpDir);

    assert.ok(await fileExists(path.join(tmpDir, "devclaw", "log", "audit.log")), "audit.log should be in devclaw/log/");
    assert.ok(!await fileExists(path.join(logDir, "audit.log")), "old log/audit.log should be removed");

    await fs.rm(tmpDir, { recursive: true });
  });
});

describe("migrateWorkspaceLayout — flat project prompts → prompts/ subdir", () => {
  it("should move flat .md files into prompts/ subdir", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-migrate-"));
    const dataDir = path.join(tmpDir, "devclaw");
    const projectDir = path.join(dataDir, "projects", "my-app");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, "projects.json"), '{"projects":{}}');
    await fs.writeFile(path.join(projectDir, "developer.md"), "# Dev");
    await fs.writeFile(path.join(projectDir, "tester.md"), "# Tester");
    await fs.writeFile(path.join(projectDir, "workflow.yaml"), "roles: {}");

    await migrateWorkspaceLayout(tmpDir);

    assert.ok(await fileExists(path.join(projectDir, "prompts", "developer.md")), "developer.md should be in prompts/");
    assert.ok(await fileExists(path.join(projectDir, "prompts", "tester.md")), "tester.md should be in prompts/");
    assert.ok(!await fileExists(path.join(projectDir, "developer.md")), "flat developer.md should be removed");
    assert.ok(await fileExists(path.join(projectDir, "workflow.yaml")), "workflow.yaml should stay");

    await fs.rm(tmpDir, { recursive: true });
  });

  it("should rename old role files during subdir migration", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-migrate-"));
    const dataDir = path.join(tmpDir, "devclaw");
    const projectDir = path.join(dataDir, "projects", "my-app");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, "projects.json"), '{"projects":{}}');
    await fs.writeFile(path.join(projectDir, "dev.md"), "# Old Dev");
    await fs.writeFile(path.join(projectDir, "qa.md"), "# Old QA");

    await migrateWorkspaceLayout(tmpDir);

    assert.ok(await fileExists(path.join(projectDir, "prompts", "developer.md")), "dev.md should become prompts/developer.md");
    assert.ok(await fileExists(path.join(projectDir, "prompts", "tester.md")), "qa.md should become prompts/tester.md");

    await fs.rm(tmpDir, { recursive: true });
  });

  it("should skip projects that already have prompts/ subdir", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-migrate-"));
    const dataDir = path.join(tmpDir, "devclaw");
    const projectDir = path.join(dataDir, "projects", "my-app");
    const promptsDir = path.join(projectDir, "prompts");
    await fs.mkdir(promptsDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, "projects.json"), '{"projects":{}}');
    await fs.writeFile(path.join(promptsDir, "developer.md"), "# Already migrated");

    await migrateWorkspaceLayout(tmpDir);

    const content = await fs.readFile(path.join(promptsDir, "developer.md"), "utf-8");
    assert.strictEqual(content, "# Already migrated", "existing prompts/ should not be touched");

    await fs.rm(tmpDir, { recursive: true });
  });
});

describe("migrateWorkspaceLayout — no-op cases", () => {
  it("should no-op when already fully migrated", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-migrate-"));
    const dataDir = path.join(tmpDir, "devclaw");
    const promptsDir = path.join(dataDir, "projects", "app", "prompts");
    await fs.mkdir(promptsDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, "projects.json"), '{"projects":{}}');
    await fs.writeFile(path.join(promptsDir, "developer.md"), "# Dev");

    await migrateWorkspaceLayout(tmpDir);

    assert.ok(await fileExists(path.join(promptsDir, "developer.md")), "prompts should still exist");

    await fs.rm(tmpDir, { recursive: true });
  });

  it("should no-op when workspace is empty", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-migrate-"));

    await migrateWorkspaceLayout(tmpDir);

    await fs.rm(tmpDir, { recursive: true });
  });
});
