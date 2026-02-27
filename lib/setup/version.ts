/**
 * setup/version.ts — DevClaw version tracking for workspaces.
 *
 * Tracks which DevClaw version last wrote to the workspace via a `.version`
 * file in the data directory. Detects upgrades and logs them to the audit trail.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "./migrate-layout.js";
import { log as auditLog } from "../audit.js";

const VERSION_FILE = ".version";

/**
 * Read the DevClaw version from package.json (bundled at build time).
 */
export function getPackageVersion(): string {
  // esbuild bundles into dist/index.js — package.json is one level up
  try {
    const pkgPath = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "package.json");
    const pkg = JSON.parse(require("node:fs").readFileSync(pkgPath, "utf-8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Read the workspace's tracked version, or null if not yet tracked.
 */
export async function readWorkspaceVersion(workspacePath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(path.join(workspacePath, DATA_DIR, VERSION_FILE), "utf-8");
    return content.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Write the current DevClaw version to the workspace.
 */
export async function writeWorkspaceVersion(workspacePath: string, version: string): Promise<void> {
  const versionPath = path.join(workspacePath, DATA_DIR, VERSION_FILE);
  await fs.mkdir(path.dirname(versionPath), { recursive: true });
  await fs.writeFile(versionPath, version + "\n", "utf-8");
}

/**
 * Check for version changes and update the workspace version file.
 * Logs upgrades to the audit trail.
 *
 * Returns { previous, current, upgraded } for callers that need the info.
 */
export async function trackVersion(workspacePath: string): Promise<{
  previous: string | null;
  current: string;
  upgraded: boolean;
}> {
  const current = getPackageVersion();
  const previous = await readWorkspaceVersion(workspacePath);

  if (previous === current) {
    return { previous, current, upgraded: false };
  }

  // Write new version
  await writeWorkspaceVersion(workspacePath, current);

  if (previous && previous !== current) {
    // Upgrade detected
    await auditLog(workspacePath, "version_upgrade", {
      from: previous,
      to: current,
    });
    return { previous, current, upgraded: true };
  }

  // First-run (no previous version) — just write, no upgrade event
  return { previous: null, current, upgraded: false };
}
