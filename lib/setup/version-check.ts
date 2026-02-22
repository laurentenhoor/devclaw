/**
 * version-check.ts — Version checking for defaults upgrades.
 *
 * Compares plugin version with installed version to detect when
 * upgrades are available. Used for startup notifications.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDefaultsManifest, type DefaultsManifest } from "../templates.js";
import { loadInstalledManifest } from "./defaults-manifest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type VersionStatus = {
  status: "up-to-date" | "outdated" | "customizations" | "error";
  pluginVersion: string | null;
  installedVersion: string | null;
  description: string;
  customizedFiles?: string[];
  outdatedFiles?: string[];
  changesAvailable?: boolean;
};

/**
 * Read plugin version from package.json.
 */
async function getPluginVersion(): Promise<string | null> {
  try {
    const packagePath = path.join(__dirname, "..", "..", "package.json");
    const content = await fs.readFile(packagePath, "utf-8");
    const pkg = JSON.parse(content);
    return pkg.version || null;
  } catch {
    return null;
  }
}

/**
 * Check version status for upgrades.
 * 
 * Returns status indicating whether defaults are up-to-date,
 * outdated, or have customizations that would be affected.
 */
export async function checkVersionStatus(workspaceDir: string): Promise<VersionStatus> {
  try {
    const pluginManifest = loadDefaultsManifest();
    if (!pluginManifest) {
      return {
        status: "error",
        pluginVersion: null,
        installedVersion: null,
        description: "Could not load plugin defaults manifest",
      };
    }

    const installedManifest = await loadInstalledManifest(workspaceDir);
    const pluginVersion = pluginManifest.version;
    const installedVersion = installedManifest?.version ?? null;

    // No installed manifest means fresh install
    if (!installedManifest) {
      return {
        status: "up-to-date",
        pluginVersion,
        installedVersion: null,
        description: "Fresh installation",
      };
    }

    // Same version - check for customizations
    if (installedVersion === pluginVersion) {
      return {
        status: "up-to-date",
        pluginVersion,
        installedVersion,
        description: "Defaults are up-to-date",
      };
    }

    // Different version - need to compare files
    const { compareManifests } = await import("./defaults-manifest.js");
    const comparison = await compareManifests(workspaceDir);
    
    if (!comparison) {
      return {
        status: "error",
        pluginVersion,
        installedVersion,
        description: "Could not compare manifests",
      };
    }

    // Check if there are customizations
    if (comparison.customized.length > 0) {
      return {
        status: "customizations",
        pluginVersion,
        installedVersion,
        description: `Upgrade available (${installedVersion} → ${pluginVersion}) but ${comparison.customized.length} file(s) have customizations`,
        customizedFiles: comparison.customized,
        changesAvailable: true,
      };
    }

    // Check if there are outdated files
    if (comparison.outdated.length > 0 || comparison.unchanged.length < Object.keys(pluginManifest.files).length) {
      return {
        status: "outdated",
        pluginVersion,
        installedVersion,
        description: `Upgrade available (${installedVersion} → ${pluginVersion})`,
        outdatedFiles: comparison.outdated,
        changesAvailable: true,
      };
    }

    return {
      status: "up-to-date",
      pluginVersion,
      installedVersion,
      description: "Defaults are up-to-date",
    };
  } catch (err) {
    return {
      status: "error",
      pluginVersion: null,
      installedVersion: null,
      description: `Version check failed: ${(err as Error).message}`,
    };
  }
}

/**
 * Get notification state from .INSTALLED_DEFAULTS.
 * Returns the version that was last notified.
 */
export async function getNotificationState(workspaceDir: string): Promise<string | null> {
  try {
    const manifest = await loadInstalledManifest(workspaceDir);
    return (manifest as any)?.notified ?? null;
  } catch {
    return null;
  }
}

/**
 * Update notification state in .INSTALLED_DEFAULTS.
 * Marks that the user has been notified about this version.
 */
export async function updateNotificationState(workspaceDir: string, version: string): Promise<void> {
  try {
    const { loadInstalledManifest, saveInstalledManifest } = await import("./defaults-manifest.js");
    const manifest = await loadInstalledManifest(workspaceDir);
    if (manifest) {
      (manifest as any).notified = version;
      await saveInstalledManifest(workspaceDir, manifest);
    }
  } catch {
    // Best-effort - don't break if update fails
  }
}
