/**
 * prompt-hashes.ts — Hash manifest for prompt customization detection.
 *
 * Stores SHA-256 hashes of default prompt files written by DevClaw.
 * On upgrade, compares the current file hash to the manifest to detect
 * user customizations (modified files are skipped, not overwritten).
 *
 * Manifest location: <dataDir>/.prompt-hashes.json
 * Stale marker:      <dataDir>/.stale-prompts.json
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const MANIFEST_FILE = ".prompt-hashes.json";
const STALE_PROMPTS_FILE = ".stale-prompts.json";

/** SHA-256 hex digest of a string. */
export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

/** Read the prompt hash manifest. Returns null if it doesn't exist. */
export async function readPromptHashes(
  dataDir: string,
): Promise<Record<string, string> | null> {
  try {
    const raw = await fs.readFile(path.join(dataDir, MANIFEST_FILE), "utf-8");
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return null;
  }
}

/** Write the prompt hash manifest. */
export async function writePromptHashes(
  dataDir: string,
  hashes: Record<string, string>,
): Promise<void> {
  await fs.writeFile(
    path.join(dataDir, MANIFEST_FILE),
    JSON.stringify(hashes, null, 2) + "\n",
    "utf-8",
  );
}

/** Read the stale-prompts marker. Returns null if it doesn't exist. */
export async function readStalePrompts(
  dataDir: string,
): Promise<string[] | null> {
  try {
    const raw = await fs.readFile(
      path.join(dataDir, STALE_PROMPTS_FILE),
      "utf-8",
    );
    return JSON.parse(raw) as string[];
  } catch {
    return null;
  }
}

/** Write the stale-prompts marker listing skipped roles. */
export async function writeStalePrompts(
  dataDir: string,
  roles: string[],
): Promise<void> {
  await fs.writeFile(
    path.join(dataDir, STALE_PROMPTS_FILE),
    JSON.stringify(roles, null, 2) + "\n",
    "utf-8",
  );
}

/** Delete the stale-prompts marker (e.g., after reset_defaults). */
export async function clearStalePrompts(dataDir: string): Promise<void> {
  try {
    await fs.unlink(path.join(dataDir, STALE_PROMPTS_FILE));
  } catch {
    /* already gone */
  }
}

/**
 * Create .bak backups for all project-specific prompt overrides.
 * Does not modify the originals — just a safety net during upgrades.
 * Returns relative paths of backed-up files (e.g. "my-app/prompts/developer.md").
 */
export async function backupProjectPrompts(dataDir: string): Promise<string[]> {
  const projectsDir = path.join(dataDir, "projects");
  const backedUp: string[] = [];
  let projects: string[];
  try {
    projects = await fs.readdir(projectsDir);
  } catch { return backedUp; }

  for (const project of projects) {
    const projPromptsDir = path.join(projectsDir, project, "prompts");
    let files: string[];
    try {
      files = (await fs.readdir(projPromptsDir)).filter(f => f.endsWith(".md"));
    } catch { continue; }
    for (const file of files) {
      const filePath = path.join(projPromptsDir, file);
      await fs.copyFile(filePath, filePath + ".bak");
      backedUp.push(`${project}/prompts/${file}`);
    }
  }
  return backedUp;
}
