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
  TOOLS_MD_TEMPLATE,
  WORKFLOW_YAML_TEMPLATE,
  DEFAULT_ROLE_INSTRUCTIONS,
} from "../templates.js";
import { getAllRoleIds } from "../roles/index.js";
import { migrateWorkspaceLayout, DATA_DIR } from "./migrate-layout.js";
import { hashContent, writePromptHashes, backupProjectPrompts } from "../prompt-hashes.js";
import { PLUGIN_VERSION } from "../upgrade.js";

/**
 * Ensure default data files exist in the workspace.
 * Structural files (workflow.yaml, projects.json) are created only if missing.
 * Prompt files are always overwritten with backups (same as workspace docs).
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

  // devclaw/prompts/ — default role instructions (backup + overwrite)
  const promptsDir = path.join(dataDir, "prompts");
  await fs.mkdir(promptsDir, { recursive: true });
  const hashes: Record<string, string> = {};
  for (const role of getAllRoleIds()) {
    const rolePath = path.join(promptsDir, `${role}.md`);
    const content = DEFAULT_ROLE_INSTRUCTIONS[role] ?? `# ${role.toUpperCase()} Worker Instructions\n\nAdd role-specific instructions here.\n`;
    await backupAndWrite(rolePath, content);
    hashes[role] = hashContent(content);
  }
  await writePromptHashes(dataDir, hashes);

  // Backup project-specific prompt overrides (safety net during re-setup)
  await backupProjectPrompts(dataDir);

  // devclaw/log/ directory (audit.log created on first write)
  await fs.mkdir(path.join(dataDir, "log"), { recursive: true });

  // Version stamp — prevents the heartbeat auto-upgrade from re-running
  // immediately after a fresh install.
  const versionPath = path.join(dataDir, ".plugin-version");
  if (!await fileExists(versionPath)) {
    await fs.writeFile(versionPath, PLUGIN_VERSION + "\n", "utf-8");
  }
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

  // IDENTITY.md (backup existing — stays at workspace root)
  await backupAndWrite(path.join(workspacePath, "IDENTITY.md"), IDENTITY_MD_TEMPLATE);
  written.push("IDENTITY.md");

  // TOOLS.md (backup existing — stays at workspace root)
  await backupAndWrite(path.join(workspacePath, "TOOLS.md"), TOOLS_MD_TEMPLATE);
  written.push("TOOLS.md");

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
// Helpers (shared with reset-defaults tool)
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
