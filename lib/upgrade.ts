/**
 * upgrade.ts — Auto-upgrade on plugin version change.
 *
 * On heartbeat startup, compares a version stamp in each workspace against
 * the running plugin version. On mismatch (or missing stamp):
 *   1. Backup + overwrite workspace docs (AGENTS.md, HEARTBEAT.md, etc.)
 *   2. Backup + overwrite default role prompts
 *   3. Reset workflow states section (preserving roles/timeouts)
 *   4. Write the new version stamp
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

/**
 * Check if a workspace needs upgrading and apply if so.
 * Returns true if an upgrade was performed.
 */
export async function upgradeWorkspaceIfNeeded(
  workspace: string,
  logger: Logger,
): Promise<boolean> {
  const installed = await readVersionStamp(workspace);
  if (installed === PLUGIN_VERSION) return false;

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

  // 2. Default role prompts (backup + overwrite)
  const promptsDir = path.join(dataDir, "prompts");
  await fsp.mkdir(promptsDir, { recursive: true });

  for (const [role, content] of Object.entries(DEFAULT_ROLE_INSTRUCTIONS)) {
    await backupAndWrite(path.join(promptsDir, `${role}.md`), content);
  }

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

  logger.info(`Workspace ${workspace} upgraded to ${PLUGIN_VERSION}`);
  return true;
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
