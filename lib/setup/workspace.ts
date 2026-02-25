/**
 * setup/workspace.ts — Workspace file scaffolding.
 *
 * On every startup, ensureDefaultFiles() overwrites prompts, workflow states,
 * and workspace docs with the latest curated defaults. User-configurable
 * sections (roles, timeouts) are preserved in workflow.yaml.
 *
 * Project-specific prompt overrides are backed up and removed so workers
 * always fall through to the workspace defaults.
 */
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import {
  AGENTS_MD_TEMPLATE,
  HEARTBEAT_MD_TEMPLATE,
  IDENTITY_MD_TEMPLATE,
  SOUL_MD_TEMPLATE,
  TOOLS_MD_TEMPLATE,
  WORKFLOW_YAML_TEMPLATE,
  DEFAULT_ROLE_INSTRUCTIONS,
} from "./templates.js";
import { getAllRoleIds } from "../roles/index.js";
import { migrateWorkspaceLayout, DATA_DIR } from "./migrate-layout.js";

/**
 * Ensure all workspace data files are up to date with the latest defaults.
 *
 * Called on every heartbeat startup. Overwrites prompts and workflow states
 * while preserving user-configurable sections (roles, timeouts).
 */
export async function ensureDefaultFiles(workspacePath: string): Promise<void> {
  const dataDir = path.join(workspacePath, DATA_DIR);

  // Workspace instruction files — always overwrite with latest
  await backupAndWrite(path.join(workspacePath, "AGENTS.md"), AGENTS_MD_TEMPLATE);
  await backupAndWrite(path.join(workspacePath, "HEARTBEAT.md"), HEARTBEAT_MD_TEMPLATE);
  await backupAndWrite(path.join(workspacePath, "IDENTITY.md"), IDENTITY_MD_TEMPLATE);
  await backupAndWrite(path.join(workspacePath, "TOOLS.md"), TOOLS_MD_TEMPLATE);

  // Remove BOOTSTRAP.md — one-time onboarding file, not needed after setup
  try { await fs.unlink(path.join(workspacePath, "BOOTSTRAP.md")); } catch { /* already gone */ }

  // devclaw/workflow.yaml — overwrite with latest template, preserve roles/timeouts
  const workflowPath = path.join(dataDir, "workflow.yaml");
  await fs.mkdir(dataDir, { recursive: true });
  if (await fileExists(workflowPath)) {
    const existing = YAML.parse(await fs.readFile(workflowPath, "utf-8")) as Record<string, unknown>;
    const doc = YAML.parseDocument(WORKFLOW_YAML_TEMPLATE);
    if (existing.roles) doc.set("roles", existing.roles);
    if (existing.timeouts) doc.set("timeouts", existing.timeouts);
    await backupAndWrite(workflowPath, doc.toString());
  } else {
    await fs.writeFile(workflowPath, WORKFLOW_YAML_TEMPLATE, "utf-8");
  }

  // devclaw/projects.json
  const projectsJsonPath = path.join(dataDir, "projects.json");
  if (!await fileExists(projectsJsonPath)) {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(projectsJsonPath, JSON.stringify({ projects: {} }, null, 2) + "\n", "utf-8");
  }

  // devclaw/projects/ directory
  await fs.mkdir(path.join(dataDir, "projects"), { recursive: true });

  // devclaw/prompts/ — force-overwrite with latest curated defaults
  const promptsDir = path.join(dataDir, "prompts");
  await fs.mkdir(promptsDir, { recursive: true });
  for (const role of getAllRoleIds()) {
    const rolePath = path.join(promptsDir, `${role}.md`);
    const content = DEFAULT_ROLE_INSTRUCTIONS[role];
    if (!content) throw new Error(`No default instructions found for role: ${role}`);
    await backupAndWrite(rolePath, content);
  }

  // Backup + remove all project-specific prompt overrides
  await backupProjectPrompts(dataDir);

  // devclaw/log/ directory (audit.log created on first write)
  await fs.mkdir(path.join(dataDir, "log"), { recursive: true });
}

/**
 * Write all workspace files for a DevClaw agent.
 * Returns the list of files that were written (skips files that already exist).
 *
 * @param defaultWorkspacePath — If provided, USER.md is copied from here (only if not already present).
 */
export async function scaffoldWorkspace(workspacePath: string, defaultWorkspacePath?: string): Promise<string[]> {
  // Migrate old layout if detected
  await migrateWorkspaceLayout(workspacePath);

  // SOUL.md (create-only — never overwrite user customizations)
  const soulPath = path.join(workspacePath, "SOUL.md");
  if (!await fileExists(soulPath)) {
    await fs.writeFile(soulPath, SOUL_MD_TEMPLATE, "utf-8");
  }

  // USER.md — copy from default workspace if available (create-only)
  const userPath = path.join(workspacePath, "USER.md");
  if (!await fileExists(userPath) && defaultWorkspacePath) {
    const sourceUser = path.join(defaultWorkspacePath, "USER.md");
    if (await fileExists(sourceUser)) {
      await fs.copyFile(sourceUser, userPath);
    }
  }

  // Ensure all defaults (workspace docs, workflow, prompts, etc.)
  await ensureDefaultFiles(workspacePath);

  return ["AGENTS.md", "HEARTBEAT.md", "IDENTITY.md", "TOOLS.md"];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export async function backupAndWrite(filePath: string, content: string): Promise<void> {
  try {
    await fs.access(filePath);
    await fs.copyFile(filePath, filePath + ".bak");
  } catch {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
  }
  await fs.writeFile(filePath, content, "utf-8");
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Backup and remove all project-specific prompt overrides.
 * Workers always fall through to the curated workspace defaults.
 */
async function backupProjectPrompts(dataDir: string): Promise<void> {
  const projectsDir = path.join(dataDir, "projects");
  let projects: string[];
  try {
    projects = await fs.readdir(projectsDir);
  } catch { return; }

  for (const project of projects) {
    const projPromptsDir = path.join(projectsDir, project, "prompts");
    let files: string[];
    try {
      files = (await fs.readdir(projPromptsDir)).filter(f => f.endsWith(".md") && !f.endsWith(".bak"));
    } catch { continue; }
    for (const file of files) {
      const filePath = path.join(projPromptsDir, file);
      await fs.copyFile(filePath, filePath + ".bak");
      await fs.unlink(filePath);
    }
  }
}
