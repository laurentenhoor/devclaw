/**
 * backup-manager.ts — Backup management for defaults upgrades.
 *
 * Handles backup creation, rotation, metadata tracking, and listing.
 */
import fs from "node:fs/promises";
import path from "node:path";

export type BackupMetadata = {
  timestamp: number;
  version: string;
  date: string;
  files: string[];
};

export type BackupInfo = {
  timestamp: number;
  date: string;
  fromVersion: string | null;
  toVersion: string | null;
  files: number;
  backupPaths: string[];
};

/**
 * Load backup metadata from .INSTALLED_DEFAULTS.
 */
export async function loadBackupMetadata(workspaceDir: string): Promise<Record<string, BackupMetadata[]> | null> {
  try {
    const { loadInstalledManifest } = await import("../setup/defaults-manifest.js");
    const manifest = await loadInstalledManifest(workspaceDir);
    return (manifest as any)?.backups ?? null;
  } catch {
    return null;
  }
}

/**
 * Save backup metadata to .INSTALLED_DEFAULTS.
 */
export async function saveBackupMetadata(
  workspaceDir: string,
  backups: Record<string, BackupMetadata[]>,
): Promise<void> {
  try {
    const { loadInstalledManifest, saveInstalledManifest } = await import("../setup/defaults-manifest.js");
    const manifest = await loadInstalledManifest(workspaceDir);
    if (manifest) {
      (manifest as any).backups = backups;
      await saveInstalledManifest(workspaceDir, manifest);
    }
  } catch {
    // Best-effort
  }
}

/**
 * Add a backup entry to metadata.
 */
export async function addBackupEntry(
  workspaceDir: string,
  file: string,
  backupPath: string,
  version: string,
): Promise<void> {
  const backups = (await loadBackupMetadata(workspaceDir)) ?? {};
  
  if (!backups[file]) {
    backups[file] = [];
  }
  
  // Extract timestamp from backup path (filename.backup.{timestamp})
  const timestampMatch = backupPath.match(/\.backup\.([^.]+)$/);
  const timestamp = timestampMatch ? parseInt(timestampMatch[1], 10) : Date.now();
  
  backups[file].push({
    timestamp,
    version,
    date: new Date(timestamp).toISOString().split("T")[0],
    files: [backupPath],
  });
  
  // Keep only last 5 backups per file
  backups[file].sort((a, b) => b.timestamp - a.timestamp);
  if (backups[file].length > 5) {
    backups[file] = backups[file].slice(0, 5);
  }
  
  await saveBackupMetadata(workspaceDir, backups);
}

/**
 * List all available backup points.
 */
export async function listAllBackups(workspaceDir: string): Promise<BackupInfo[]> {
  const backupMetadata = await loadBackupMetadata(workspaceDir);
  if (!backupMetadata) return [];
  
  // Group by timestamp
  const backupsByTimestamp = new Map<number, BackupInfo>();
  
  for (const [file, entries] of Object.entries(backupMetadata)) {
    for (const entry of entries) {
      const existing = backupsByTimestamp.get(entry.timestamp);
      if (existing) {
        existing.files++;
        existing.backupPaths.push(...entry.files);
      } else {
        backupsByTimestamp.set(entry.timestamp, {
          timestamp: entry.timestamp,
          date: entry.date,
          fromVersion: entry.version,
          toVersion: null, // Will be determined from next backup
          files: 1,
          backupPaths: [...entry.files],
        });
      }
    }
  }
  
  // Sort by timestamp descending (newest first)
  const backups = Array.from(backupsByTimestamp.values()).sort((a, b) => b.timestamp - a.timestamp);
  
  // Set toVersion from the next backup
  for (let i = 0; i < backups.length - 1; i++) {
    backups[i].toVersion = backups[i + 1].fromVersion;
  }
  
  return backups;
}

/**
 * Check if a backup timestamp is old (>30 days).
 */
export function isOldBackup(timestamp: number): boolean {
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  return timestamp < thirtyDaysAgo;
}

/**
 * Format a backup info for display.
 */
export function formatBackupInfo(backup: BackupInfo, index: number): string {
  const date = new Date(backup.timestamp).toISOString().replace("T", " ").split(".")[0] + " UTC";
  const versionInfo = backup.toVersion 
    ? `${backup.fromVersion} → ${backup.toVersion}`
    : backup.fromVersion ?? "Unknown";
  
  const ageWarning = isOldBackup(backup.timestamp) ? " ⚠️ (>30 days old)" : "";
  
  return `${index + 1}. Timestamp: ${backup.timestamp} (${date})${ageWarning}
   Version: ${versionInfo}
   Files: ${backup.files}
   Use: openclaw devclaw upgrade-defaults --rollback --timestamp ${backup.timestamp}`;
}
