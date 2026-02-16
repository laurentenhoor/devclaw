/**
 * setup/workspace.ts — Workspace file scaffolding.
 *
 * Writes AGENTS.md, HEARTBEAT.md, default role prompts, and projects.json.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  AGENTS_MD_TEMPLATE,
  HEARTBEAT_MD_TEMPLATE,
  IDENTITY_MD_TEMPLATE,
  SOUL_MD_TEMPLATE,
  WORKFLOW_YAML_TEMPLATE,
  DEFAULT_ROLE_INSTRUCTIONS,
} from "../templates.js";
import { getAllRoleIds } from "../roles/index.js";
import { migrateWorkspaceLayout, DATA_DIR } from "./migrate-layout.js";

/**
 * Ensure default data files exist in the workspace.
 * Only creates files that are missing — never overwrites existing ones.
 * Called automatically after migration (via ensureWorkspaceMigrated).
 */
export async function ensureDefaultFiles(workspacePath: string): Promise<void> {
  const dataDir = path.join(workspacePath, DATA_DIR);

  // devclaw/workflow.yaml
  const workflowPath = path.join(dataDir, "workflow.yaml");
  if (!await fileExists(workflowPath)) {
    await fs.mkdir(dataDir, { recursive: true });
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

  // devclaw/prompts/ — default role instructions
  const promptsDir = path.join(dataDir, "prompts");
  await fs.mkdir(promptsDir, { recursive: true });
  for (const role of getAllRoleIds()) {
    const rolePath = path.join(promptsDir, `${role}.md`);
    if (!await fileExists(rolePath)) {
      const content = DEFAULT_ROLE_INSTRUCTIONS[role] ?? `# ${role.toUpperCase()} Worker Instructions\n\nAdd role-specific instructions here.\n`;
      await fs.writeFile(rolePath, content, "utf-8");
    }
  }

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

  const written: string[] = [];

  // AGENTS.md (backup existing — stays at workspace root)
  await backupAndWrite(path.join(workspacePath, "AGENTS.md"), AGENTS_MD_TEMPLATE);
  written.push("AGENTS.md");

  // HEARTBEAT.md (stays at workspace root)
  await backupAndWrite(path.join(workspacePath, "HEARTBEAT.md"), HEARTBEAT_MD_TEMPLATE);
  written.push("HEARTBEAT.md");

  // IDENTITY.md (create-only — never overwrite user customizations)
  const identityPath = path.join(workspacePath, "IDENTITY.md");
  if (!await fileExists(identityPath)) {
    await fs.writeFile(identityPath, IDENTITY_MD_TEMPLATE, "utf-8");
    written.push("IDENTITY.md");
  }

  // SOUL.md (create-only — never overwrite user customizations)
  const soulPath = path.join(workspacePath, "SOUL.md");
  if (!await fileExists(soulPath)) {
    await fs.writeFile(soulPath, SOUL_MD_TEMPLATE, "utf-8");
    written.push("SOUL.md");
  }

  // USER.md — copy from default workspace if available (create-only)
  const userPath = path.join(workspacePath, "USER.md");
  if (!await fileExists(userPath) && defaultWorkspacePath) {
    const sourceUser = path.join(defaultWorkspacePath, "USER.md");
    if (await fileExists(sourceUser)) {
      await fs.copyFile(sourceUser, userPath);
      written.push("USER.md");
    }
  }

  // Ensure all data-dir defaults (workflow.yaml, prompts, etc.)
  await ensureDefaultFiles(workspacePath);

  return written;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

async function backupAndWrite(filePath: string, content: string): Promise<void> {
  try {
    await fs.access(filePath);
    await fs.copyFile(filePath, filePath + ".bak");
  } catch {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
  }
  await fs.writeFile(filePath, content, "utf-8");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
