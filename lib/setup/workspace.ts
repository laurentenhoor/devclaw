/**
 * setup/workspace.ts — Workspace file scaffolding.
 *
 * ensureDefaultFiles() creates directories and missing structural files only.
 * User-customized files (workflow.yaml, prompts, workspace docs) are never
 * overwritten on startup. Package defaults serve as in-memory fallbacks
 * when files are missing (see bootstrap-hook.ts loadRoleInstructions).
 *
 * To explicitly write/reset defaults, use setup --eject-defaults or --reset-defaults.
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
import { trackVersion } from "./version.js";

/** Sentinel file indicating the workspace has been initialized. */
const INITIALIZED_SENTINEL = ".initialized";

/**
 * Ensure workspace directories and structural files exist.
 *
 * Called on every heartbeat startup. Only creates directories and files that
 * are missing — never overwrites existing user customizations.
 * Package defaults are used as in-memory fallbacks at runtime.
 */
export async function ensureDefaultFiles(workspacePath: string): Promise<void> {
  const dataDir = path.join(workspacePath, DATA_DIR);

  // Ensure directories exist
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(path.join(dataDir, "projects"), { recursive: true });
  await fs.mkdir(path.join(dataDir, "prompts"), { recursive: true });
  await fs.mkdir(path.join(dataDir, "log"), { recursive: true });

  // Workspace instruction files — create only if missing
  await writeIfMissing(path.join(workspacePath, "AGENTS.md"), AGENTS_MD_TEMPLATE);
  await writeIfMissing(path.join(workspacePath, "HEARTBEAT.md"), HEARTBEAT_MD_TEMPLATE);
  await writeIfMissing(path.join(workspacePath, "IDENTITY.md"), IDENTITY_MD_TEMPLATE);
  await writeIfMissing(path.join(workspacePath, "TOOLS.md"), TOOLS_MD_TEMPLATE);

  // Remove BOOTSTRAP.md — one-time onboarding file, not needed after setup
  try { await fs.unlink(path.join(workspacePath, "BOOTSTRAP.md")); } catch { /* already gone */ }

  // devclaw/workflow.yaml — create only if missing
  const workflowPath = path.join(dataDir, "workflow.yaml");
  await writeIfMissing(workflowPath, WORKFLOW_YAML_TEMPLATE);

  // devclaw/projects.json — create only if missing
  const projectsJsonPath = path.join(dataDir, "projects.json");
  await writeIfMissing(projectsJsonPath, JSON.stringify({ projects: {} }, null, 2) + "\n");

  // devclaw/prompts/ — create only if missing (package defaults used as runtime fallback)
  for (const role of getAllRoleIds()) {
    const rolePath = path.join(dataDir, "prompts", `${role}.md`);
    const content = DEFAULT_ROLE_INSTRUCTIONS[role];
    if (content) await writeIfMissing(rolePath, content);
  }

  // Mark workspace as initialized
  const sentinelPath = path.join(dataDir, INITIALIZED_SENTINEL);
  await writeIfMissing(sentinelPath, new Date().toISOString() + "\n");

  // Track version — detect upgrades and log to audit trail
  await trackVersion(workspacePath);
}

/**
 * Write all package defaults to workspace.
 * Used by setup --eject-defaults and --reset-defaults.
 *
 * @param force — If true, overwrite existing files (reset-defaults). If false, skip existing (eject-defaults).
 * @returns List of files written.
 */
export async function writeAllDefaults(workspacePath: string, force = false): Promise<string[]> {
  const dataDir = path.join(workspacePath, DATA_DIR);
  const written: string[] = [];

  // Ensure directories
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(path.join(dataDir, "projects"), { recursive: true });
  await fs.mkdir(path.join(dataDir, "prompts"), { recursive: true });
  await fs.mkdir(path.join(dataDir, "log"), { recursive: true });

  const files: Array<[string, string]> = [
    [path.join(workspacePath, "AGENTS.md"), AGENTS_MD_TEMPLATE],
    [path.join(workspacePath, "HEARTBEAT.md"), HEARTBEAT_MD_TEMPLATE],
    [path.join(workspacePath, "IDENTITY.md"), IDENTITY_MD_TEMPLATE],
    [path.join(workspacePath, "TOOLS.md"), TOOLS_MD_TEMPLATE],
    [path.join(dataDir, "workflow.yaml"), WORKFLOW_YAML_TEMPLATE],
  ];

  for (const role of getAllRoleIds()) {
    const content = DEFAULT_ROLE_INSTRUCTIONS[role];
    if (content) files.push([path.join(dataDir, "prompts", `${role}.md`), content]);
  }

  for (const [filePath, content] of files) {
    if (force) {
      await backupAndWrite(filePath, content);
      written.push(path.relative(workspacePath, filePath));
    } else {
      if (await writeIfMissing(filePath, content)) {
        written.push(path.relative(workspacePath, filePath));
      }
    }
  }

  return written;
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

  // Ensure directories and missing structural files
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

/**
 * Write a file only if it doesn't exist. Returns true if file was written.
 */
async function writeIfMissing(filePath: string, content: string): Promise<boolean> {
  if (await fileExists(filePath)) return false;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
  return true;
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
