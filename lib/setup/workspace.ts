/**
 * setup/workspace.ts — Workspace file scaffolding.
 *
 * Writes AGENTS.md, HEARTBEAT.md, default role instructions, and projects.json.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  AGENTS_MD_TEMPLATE,
  HEARTBEAT_MD_TEMPLATE,
  DEFAULT_DEV_INSTRUCTIONS,
  DEFAULT_QA_INSTRUCTIONS,
} from "../templates.js";

/**
 * Write all workspace files for a DevClaw agent.
 * Returns the list of files that were written (skips files that already exist).
 */
export async function scaffoldWorkspace(workspacePath: string): Promise<string[]> {
  const filesWritten: string[] = [];

  // AGENTS.md (backup existing)
  await backupAndWrite(path.join(workspacePath, "AGENTS.md"), AGENTS_MD_TEMPLATE);
  filesWritten.push("AGENTS.md");

  // HEARTBEAT.md
  await backupAndWrite(path.join(workspacePath, "HEARTBEAT.md"), HEARTBEAT_MD_TEMPLATE);
  filesWritten.push("HEARTBEAT.md");

  // projects/projects.json
  const projectsDir = path.join(workspacePath, "projects");
  await fs.mkdir(projectsDir, { recursive: true });
  const projectsJsonPath = path.join(projectsDir, "projects.json");
  if (!await fileExists(projectsJsonPath)) {
    await fs.writeFile(projectsJsonPath, JSON.stringify({ projects: {} }, null, 2) + "\n", "utf-8");
    filesWritten.push("projects/projects.json");
  }

  // projects/roles/default/ (fallback role instructions)
  const defaultRolesDir = path.join(projectsDir, "roles", "default");
  await fs.mkdir(defaultRolesDir, { recursive: true });
  const devRolePath = path.join(defaultRolesDir, "dev.md");
  if (!await fileExists(devRolePath)) {
    await fs.writeFile(devRolePath, DEFAULT_DEV_INSTRUCTIONS, "utf-8");
    filesWritten.push("projects/roles/default/dev.md");
  }
  const qaRolePath = path.join(defaultRolesDir, "qa.md");
  if (!await fileExists(qaRolePath)) {
    await fs.writeFile(qaRolePath, DEFAULT_QA_INSTRUCTIONS, "utf-8");
    filesWritten.push("projects/roles/default/qa.md");
  }

  // log/ directory (audit.log created on first write)
  const logDir = path.join(workspacePath, "log");
  await fs.mkdir(logDir, { recursive: true });

  return filesWritten;
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
