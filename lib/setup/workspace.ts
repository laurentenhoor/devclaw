/**
 * setup/workspace.ts — Workspace file scaffolding.
 *
 * On startup, ensureDefaultFiles() creates missing workspace files with curated
 * defaults. User-owned config files (workflow.yaml, prompts, IDENTITY.md) are
 * write-once: created if missing, never overwritten. System instruction files
 * (AGENTS.md, HEARTBEAT.md, TOOLS.md) are always refreshed.
 *
 * The runtime config loader (lib/config/loader.ts) uses a three-layer merge with
 * built-in fallbacks, so missing keys in workflow.yaml are handled automatically.
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
} from "./templates.js";
import { getAllRoleIds } from "../roles/index.js";
import { migrateWorkspaceLayout, DATA_DIR } from "./migrate-layout.js";
import { writeVersionFile, detectUpgrade } from "./version.js";
import { log as auditLog } from "../audit.js";

/**
 * Ensure all workspace data files are up to date.
 *
 * Called on every heartbeat startup.
 *
 * File categories:
 *   - System instructions (AGENTS.md, HEARTBEAT.md, TOOLS.md): always overwrite
 *   - User-owned config (workflow.yaml, prompts, IDENTITY.md): create-only
 *   - Runtime state (projects.json): create-only
 */
export async function ensureDefaultFiles(workspacePath: string): Promise<void> {
  const dataDir = path.join(workspacePath, DATA_DIR);
  await fs.mkdir(dataDir, { recursive: true });

  // --- System instruction files — always overwrite with latest ---
  await backupAndWrite(path.join(workspacePath, "AGENTS.md"), AGENTS_MD_TEMPLATE);
  await backupAndWrite(path.join(workspacePath, "HEARTBEAT.md"), HEARTBEAT_MD_TEMPLATE);
  await backupAndWrite(path.join(workspacePath, "TOOLS.md"), TOOLS_MD_TEMPLATE);

  // --- User-owned files — create-only, never overwrite ---

  // IDENTITY.md
  const identityPath = path.join(workspacePath, "IDENTITY.md");
  if (!await fileExists(identityPath)) {
    await fs.writeFile(identityPath, IDENTITY_MD_TEMPLATE, "utf-8");
  }

  // Remove BOOTSTRAP.md — one-time onboarding file, not needed after setup
  try { await fs.unlink(path.join(workspacePath, "BOOTSTRAP.md")); } catch { /* already gone */ }

  // devclaw/workflow.yaml — create-only (three-layer merge handles defaults for missing keys)
  const workflowPath = path.join(dataDir, "workflow.yaml");
  if (!await fileExists(workflowPath)) {
    await fs.writeFile(workflowPath, WORKFLOW_YAML_TEMPLATE, "utf-8");
  }

  // devclaw/projects.json — create-only
  const projectsJsonPath = path.join(dataDir, "projects.json");
  if (!await fileExists(projectsJsonPath)) {
    await fs.writeFile(projectsJsonPath, JSON.stringify({ projects: {} }, null, 2) + "\n", "utf-8");
  }

  // devclaw/projects/ directory
  await fs.mkdir(path.join(dataDir, "projects"), { recursive: true });

  // devclaw/prompts/ — create-only per role (user customizations are preserved)
  const promptsDir = path.join(dataDir, "prompts");
  await fs.mkdir(promptsDir, { recursive: true });
  for (const role of getAllRoleIds()) {
    const rolePath = path.join(promptsDir, `${role}.md`);
    if (!await fileExists(rolePath)) {
      const content = DEFAULT_ROLE_INSTRUCTIONS[role];
      if (!content) throw new Error(`No default instructions found for role: ${role}`);
      await fs.writeFile(rolePath, content, "utf-8");
    }
  }

  // Note: project-specific prompts (devclaw/projects/*/prompts/*.md) are never
  // touched. They are intentional user customizations.

  // devclaw/log/ directory (audit.log created on first write)
  await fs.mkdir(path.join(dataDir, "log"), { recursive: true });

  // Version tracking
  const upgrade = await detectUpgrade(dataDir);
  await writeVersionFile(dataDir);
  if (upgrade) {
    await auditLog(workspacePath, "version_upgrade", {
      from: upgrade.from,
      to: upgrade.to,
    });
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

  return ["AGENTS.md", "HEARTBEAT.md", "TOOLS.md"];
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
