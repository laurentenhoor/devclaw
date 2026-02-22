/**
 * defaults-manifest.ts — Hash-based version tracking for workspace defaults.
 *
 * Implements SHA256-based comparison to detect:
 * - Which files have been customized by the user
 * - Which files are outdated (plugin updated but workspace hasn't)
 * - Which files are safe to auto-upgrade
 *
 * The manifest (DEFAULTS.json) is generated at build time and includes SHA256
 * hashes of all default files. On workspace creation, a snapshot of installed
 * hashes is saved to .INSTALLED_DEFAULTS for future comparison.
 */
import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { loadDefaultsManifest, type DefaultsManifest } from "../templates.js";

/**
 * Installed defaults snapshot stored in workspace root.
 * Created on first setup, updated when defaults are upgraded.
 */
const INSTALLED_MANIFEST_FILE = ".INSTALLED_DEFAULTS";

/**
 * Calculate SHA256 hash of a file.
 * Returns null if file doesn't exist.
 */
export async function calculateHash(filePath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return crypto.createHash("sha256").update(content).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Load the plugin's DEFAULTS.json manifest.
 * This contains SHA256 hashes of all default files shipped with the plugin.
 */
export function loadManifest(): DefaultsManifest | null {
  return loadDefaultsManifest();
}

/**
 * Load the workspace's .INSTALLED_DEFAULTS snapshot.
 * This contains the hashes of defaults that were installed when the workspace was created.
 * Returns null if the file doesn't exist (first run or legacy workspace).
 */
export async function loadInstalledManifest(workspaceDir: string): Promise<DefaultsManifest | null> {
  try {
    const manifestPath = path.join(workspaceDir, INSTALLED_MANIFEST_FILE);
    const content = await fs.readFile(manifestPath, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Save the installed defaults snapshot to workspace root.
 * Called after workspace creation or defaults upgrade.
 */
export async function saveInstalledManifest(workspaceDir: string, manifest: DefaultsManifest): Promise<void> {
  const manifestPath = path.join(workspaceDir, INSTALLED_MANIFEST_FILE);
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

/**
 * Comparison result between plugin defaults and workspace files.
 */
export type ComparisonResult = {
  /** Plugin version (from DEFAULTS.json) */
  pluginVersion: string;
  /** Installed version (from .INSTALLED_DEFAULTS, null if never tracked) */
  installedVersion: string | null;
  /** Files that exist in workspace and match plugin defaults exactly */
  unchanged: string[];
  /** Files that have been customized by the user (hash mismatch) */
  customized: string[];
  /** Files that are missing from the workspace */
  missing: string[];
  /** Files that are outdated (plugin updated but workspace hasn't) */
  outdated: string[];
};

/**
 * Compare plugin defaults manifest with workspace files and installed snapshot.
 *
 * This function:
 * 1. Loads the plugin's DEFAULTS.json (what the plugin ships)
 * 2. Loads the workspace's .INSTALLED_DEFAULTS (what was installed)
 * 3. Calculates current hashes of workspace files
 * 4. Categorizes each file as unchanged/customized/missing/outdated
 *
 * @param workspaceDir - Path to workspace root
 * @returns Comparison result with categorized files
 */
export async function compareManifests(workspaceDir: string): Promise<ComparisonResult | null> {
  const pluginManifest = loadManifest();
  if (!pluginManifest) return null;

  const installedManifest = await loadInstalledManifest(workspaceDir);

  const result: ComparisonResult = {
    pluginVersion: pluginManifest.version,
    installedVersion: installedManifest?.version ?? null,
    unchanged: [],
    customized: [],
    missing: [],
    outdated: [],
  };

  for (const [relPath, pluginFile] of Object.entries(pluginManifest.files)) {
    const workspacePath = path.join(workspaceDir, relPath);
    const currentHash = await calculateHash(workspacePath);

    if (currentHash === null) {
      // File is missing from workspace
      result.missing.push(relPath);
      continue;
    }

    const installedFile = installedManifest?.files[relPath];
    const installedHash = installedFile?.hash;

    if (currentHash === pluginFile.hash) {
      // File matches plugin default exactly
      result.unchanged.push(relPath);
    } else if (installedHash && currentHash === installedHash && installedHash !== pluginFile.hash) {
      // File matches what was installed, but plugin has updated → outdated
      result.outdated.push(relPath);
    } else {
      // File has been modified by user → customized
      result.customized.push(relPath);
    }
  }

  return result;
}

/**
 * Create a retroactive installed manifest from current workspace files.
 * Used when .INSTALLED_DEFAULTS doesn't exist (first run or legacy workspace).
 *
 * This creates a snapshot of the current state so future comparisons can
 * detect which files the user has customized.
 */
export async function createRetroactiveManifest(workspaceDir: string): Promise<DefaultsManifest | null> {
  const pluginManifest = loadManifest();
  if (!pluginManifest) return null;

  const retroManifest: DefaultsManifest = {
    version: pluginManifest.version,
    createdAt: new Date().toISOString(),
    files: {},
  };

  for (const relPath of Object.keys(pluginManifest.files)) {
    const workspacePath = path.join(workspaceDir, relPath);
    const hash = await calculateHash(workspacePath);
    if (hash) {
      retroManifest.files[relPath] = {
        hash,
        updatedAt: new Date().toISOString(),
      };
    }
  }

  return retroManifest;
}
