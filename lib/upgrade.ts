/**
 * upgrade.ts — Auto-upgrade on plugin version change.
 *
 * On heartbeat startup, compares a version stamp in each workspace against
 * the running plugin version. On mismatch (or missing stamp):
 *   1. Backup + overwrite workspace docs (AGENTS.md, HEARTBEAT.md, etc.)
 *   2. Smart-upgrade role prompts (skip customized files, warn user)
 *   3. Reset workflow states section (preserving roles/timeouts)
 *   4. Write the new version stamp
 *
 * Customization detection: a hash manifest (.prompt-hashes.json) tracks what
 * DevClaw last wrote. On upgrade, if the file hash matches the manifest →
 * safe to overwrite. If it differs → user customized it → skip + warn.
 * If no manifest exists (first smart upgrade) → force-overwrite all + write manifest.
 *
 * Also checks npm for a newer published version and installs it via
 * `openclaw plugins install`.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { DATA_DIR } from "./setup/migrate-layout.js";
import { backupAndWrite, fileExists } from "./setup/workspace.js";
import {
  AGENTS_MD_TEMPLATE,
  HEARTBEAT_MD_TEMPLATE,
  IDENTITY_MD_TEMPLATE,
  TOOLS_MD_TEMPLATE,
  WORKFLOW_YAML_TEMPLATE,
  DEFAULT_ROLE_INSTRUCTIONS,
} from "./templates.js";
import { runCommand } from "./run-command.js";
import {
  hashContent,
  readPromptHashes,
  writePromptHashes,
  writeStalePrompts,
  clearStalePrompts,
  backupProjectPrompts,
} from "./prompt-hashes.js";

// ---------------------------------------------------------------------------
// Version — injected by esbuild at build time, with runtime fallback for tests
// ---------------------------------------------------------------------------

declare const __PLUGIN_VERSION__: string | undefined;
declare const __PACKAGE_NAME__: string | undefined;

function readPkgField(field: "version" | "name"): string {
  const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  return pkg[field];
}

/** Current running plugin version. */
export const PLUGIN_VERSION: string =
  typeof __PLUGIN_VERSION__ !== "undefined" ? __PLUGIN_VERSION__ : readPkgField("version");

/** Package name on npm. */
const PACKAGE_NAME: string =
  typeof __PACKAGE_NAME__ !== "undefined" ? __PACKAGE_NAME__ : readPkgField("name");

const VERSION_FILE = ".plugin-version";

// ---------------------------------------------------------------------------
// Version stamp helpers
// ---------------------------------------------------------------------------

async function readVersionStamp(workspace: string): Promise<string | null> {
  try {
    return (await fsp.readFile(path.join(workspace, DATA_DIR, VERSION_FILE), "utf-8")).trim();
  } catch {
    return null;
  }
}

async function writeVersionStamp(workspace: string): Promise<void> {
  const dataDir = path.join(workspace, DATA_DIR);
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.writeFile(path.join(dataDir, VERSION_FILE), PLUGIN_VERSION + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Workspace upgrade
// ---------------------------------------------------------------------------

type Logger = {
  info(msg: string): void;
  warn(msg: string): void;
};

export type UpgradeResult = {
  upgraded: boolean;
  /** Prompt files that were skipped because the user customized them. */
  skippedPrompts: string[];
};

/**
 * Check if a workspace needs upgrading and apply if so.
 */
export async function upgradeWorkspaceIfNeeded(
  workspace: string,
  logger: Logger,
): Promise<UpgradeResult> {
  const installed = await readVersionStamp(workspace);
  if (installed === PLUGIN_VERSION) return { upgraded: false, skippedPrompts: [] };

  const from = installed ?? "unknown";
  logger.info(`Upgrading workspace ${workspace} from ${from} to ${PLUGIN_VERSION}`);

  const dataDir = path.join(workspace, DATA_DIR);

  // 1. Workspace docs (backup + overwrite)
  const docs: Array<[string, string]> = [
    ["AGENTS.md", AGENTS_MD_TEMPLATE],
    ["HEARTBEAT.md", HEARTBEAT_MD_TEMPLATE],
    ["IDENTITY.md", IDENTITY_MD_TEMPLATE],
    ["TOOLS.md", TOOLS_MD_TEMPLATE],
  ];

  for (const [name, template] of docs) {
    await backupAndWrite(path.join(workspace, name), template);
  }

  // 2. Smart-upgrade role prompts (detect customizations, skip modified files)
  const skippedPrompts = await upgradePrompts(dataDir, logger);

  // 3. Workflow states section (preserve roles/timeouts)
  const workflowPath = path.join(dataDir, "workflow.yaml");

  if (await fileExists(workflowPath)) {
    const existing = YAML.parse(await fsp.readFile(workflowPath, "utf-8")) as Record<string, unknown>;
    const doc = YAML.parseDocument(WORKFLOW_YAML_TEMPLATE);
    if (existing.roles) doc.set("roles", existing.roles);
    if (existing.timeouts) doc.set("timeouts", existing.timeouts);
    await fsp.copyFile(workflowPath, workflowPath + ".bak");
    await fsp.writeFile(workflowPath, doc.toString(), "utf-8");
  } else {
    await fsp.mkdir(dataDir, { recursive: true });
    await fsp.writeFile(workflowPath, WORKFLOW_YAML_TEMPLATE, "utf-8");
  }

  // 4. Stamp the new version
  await writeVersionStamp(workspace);

  if (skippedPrompts.length > 0) {
    logger.warn(
      `Customized prompt files not updated: ${skippedPrompts.join(", ")}. Run reset_defaults to get the latest.`,
    );
  }

  logger.info(`Workspace ${workspace} upgraded to ${PLUGIN_VERSION}`);
  return { upgraded: true, skippedPrompts };
}

/**
 * Smart-upgrade role prompt files using the hash manifest.
 *
 * - No manifest (first smart upgrade): force-overwrite all + write manifest.
 * - With manifest: compare current file hash to manifest. If unmodified →
 *   overwrite. If customized → skip + record.
 *
 * Returns list of skipped role names (customized files).
 */
async function upgradePrompts(
  dataDir: string,
  logger: Logger,
): Promise<string[]> {
  const promptsDir = path.join(dataDir, "prompts");
  await fsp.mkdir(promptsDir, { recursive: true });

  const manifest = await readPromptHashes(dataDir);
  const newHashes: Record<string, string> = {};
  const skipped: string[] = [];

  for (const [role, defaultContent] of Object.entries(DEFAULT_ROLE_INSTRUCTIONS)) {
    const filePath = path.join(promptsDir, `${role}.md`);
    const newHash = hashContent(defaultContent);

    if (!manifest) {
      // No manifest — bootstrap release: force-overwrite everything
      await backupAndWrite(filePath, defaultContent);
      newHashes[role] = newHash;
      continue;
    }

    // Check if the file was customized by comparing to what we last wrote
    const manifestHash = manifest[role];
    let currentHash: string | null = null;
    try {
      const current = await fsp.readFile(filePath, "utf-8");
      currentHash = hashContent(current);
    } catch {
      // File doesn't exist — write the default
    }

    if (!currentHash) {
      // File missing — write default
      await fsp.writeFile(filePath, defaultContent, "utf-8");
      newHashes[role] = newHash;
    } else if (!manifestHash || currentHash === manifestHash) {
      // Unmodified (matches what we last wrote) or no previous hash — safe to overwrite
      await backupAndWrite(filePath, defaultContent);
      newHashes[role] = newHash;
    } else {
      // Customized — skip
      skipped.push(role);
      newHashes[role] = manifestHash; // Keep the old manifest hash
      logger.info(`Skipping customized prompt: ${role}.md`);
    }
  }

  await writePromptHashes(dataDir, newHashes);

  // Backup project-specific prompt overrides (don't modify — just create .bak safety net)
  const projectBackups = await backupProjectPrompts(dataDir);
  if (projectBackups.length > 0) {
    logger.info(
      `Backed up project prompt overrides: ${projectBackups.join(", ")}`,
    );
  }

  // Manage stale-prompts marker
  if (skipped.length > 0) {
    await writeStalePrompts(dataDir, skipped);
  } else {
    await clearStalePrompts(dataDir);
  }

  return skipped;
}

// ---------------------------------------------------------------------------
// npm self-update
// ---------------------------------------------------------------------------

/**
 * Check npm for a newer version and install it via `openclaw plugins install`.
 * Returns the new version string if updated, null otherwise.
 */
export async function checkAndInstallUpdate(logger: Logger): Promise<string | null> {
  try {
    const result = await runCommand(
      ["npm", "view", PACKAGE_NAME, "version"],
      { timeoutMs: 15_000 },
    );
    const latest = result.stdout.trim();
    if (!latest || latest === PLUGIN_VERSION) return null;

    // Simple semver comparison: only upgrade if latest is strictly newer.
    // Split into [major, minor, patch] and compare numerically.
    if (!isNewer(latest, PLUGIN_VERSION)) return null;

    logger.info(`New version available: ${latest} (current: ${PLUGIN_VERSION}). Installing...`);
    await runCommand(
      ["openclaw", "plugins", "install", PACKAGE_NAME],
      { timeoutMs: 120_000 },
    );
    logger.info(`Updated to ${PACKAGE_NAME}@${latest}. Restart the gateway to activate.`);
    return latest;
  } catch (err) {
    logger.warn(`Auto-update check failed: ${(err as Error).message}`);
    return null;
  }
}

/** Return true if version `a` is strictly newer than `b` (simple semver). */
function isNewer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return false;
}
