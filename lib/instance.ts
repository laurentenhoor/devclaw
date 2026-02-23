/**
 * instance.ts — Persistent instance identity.
 *
 * Each workspace gets a unique fun name (CS pioneer) stored in
 * <workspace>/devclaw/instance.json. The name is generated on first
 * access and persisted across restarts.
 *
 * Can be overridden via `instance.name` in workflow.yaml.
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { nameFromSeed } from "./names.js";
import { DATA_DIR } from "./setup/migrate-layout.js";

export type InstanceIdentity = {
  name: string;
  createdAt: string;
};

function instancePath(workspaceDir: string): string {
  return path.join(workspaceDir, DATA_DIR, "instance.json");
}

/**
 * Load the instance name for this workspace.
 *
 * Resolution order:
 *   1. configOverride (from resolved workflow.yaml `instance.name`)
 *   2. Persisted instance.json
 *   3. Auto-generate from hostname + workspace path, persist, return
 */
export async function loadInstanceName(
  workspaceDir: string,
  configOverride?: string,
): Promise<string> {
  if (configOverride) return configOverride;

  const filePath = instancePath(workspaceDir);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const identity = JSON.parse(raw) as InstanceIdentity;
    if (identity.name) return identity.name;
  } catch {
    // File doesn't exist or is corrupt — generate below
  }

  // Auto-generate and persist
  const seed = `${os.hostname()}:${workspaceDir}`;
  const name = nameFromSeed(seed);
  const identity: InstanceIdentity = {
    name,
    createdAt: new Date().toISOString(),
  };

  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(identity, null, 2) + "\n", "utf-8");
  } catch {
    // Non-fatal: instance name still works for this session
  }

  return name;
}
