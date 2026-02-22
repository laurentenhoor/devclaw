/**
 * defaults-manifest — Hash-based version tracking for workspace defaults.
 *
 * ## Overview
 *
 * DevClaw uses a manifest file (`.INSTALLED_DEFAULTS`) to track which default
 * files are installed and their versions. This enables the `upgrade-defaults`
 * tool to detect user customizations and preserve them during upgrades.
 *
 * ## Manifest Format
 *
 * `.INSTALLED_DEFAULTS` is a JSON file in the workspace root:
 *
 * ```json
 * {
 *   "AGENTS.md": {
 *     "hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
 *     "timestamp": 1708564800
 *   },
 *   "HEARTBEAT.md": {
 *     "hash": "5feceb66ffc86f38d952786c6d696c79c2dbc238c4cafb11f2271d7f50b59ca9",
 *     "timestamp": 1708564800
 *   },
 *   "IDENTITY.md": {
 *     "hash": "a6e9570bcabf3e6827291c2dd4d910f850304acf451ce8b048fa2151a8fb27e3",
 *     "timestamp": 1708564800
 *   },
 *   "TOOLS.md": {
 *     "hash": "6d7fce9fee471194aa8b5b6ff15db684b0b752c8ca2f4b8c02dc1cbf30f7c4d3",
 *     "timestamp": 1708564800
 *   },
 *   "devclaw/workflow.yaml": {
 *     "hash": "3f39d5c348e5b3f7651c1ae8e0b91c2e8e9c8c9c9c9c9c9c9c9c9c9c9c9c9c",
 *     "timestamp": 1708564800
 *   },
 *   "devclaw/prompts/developer.md": {
 *     "hash": "2a4f3b8c7d1e9f6a5b8c1d4e7f2a5b8c1d4e7f2a5b8c1d4e7f2a5b8c1d4e7f",
 *     "timestamp": 1708564800
 *   },
 *   "devclaw/prompts/tester.md": {
 *     "hash": "9c8d7e6f5a4b3c2d1e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b",
 *     "timestamp": 1708564800
 *   },
 *   "devclaw/prompts/reviewer.md": {
 *     "hash": "1f2e3d4c5b6a7f8e9d0c1b2a3f4e5d6c7b8a9f0e1d2c3b4a5f6e7d8c9b0a",
 *     "timestamp": 1708564800
 *   },
 *   "devclaw/prompts/architect.md": {
 *     "hash": "8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c",
 *     "timestamp": 1708564800
 *   }
 * }
 * ```
 *
 * Each entry contains:
 * - `hash` — SHA256 hash of the default file when installed
 * - `timestamp` — Unix timestamp of when the file was last installed/upgraded
 *
 * ## Customization Detection
 *
 * The `upgrade-defaults` tool uses this manifest to detect which files you've
 * customized:
 *
 * 1. **Read manifest** → Load `.INSTALLED_DEFAULTS`
 * 2. **For each file:**
 *    a. Read current file content
 *    b. Compute SHA256 hash
 *    c. Compare to manifest hash:
 *       - **Match** → You haven't modified it → safe to update
 *       - **Different** → You customized it → skip or merge
 *       - **No entry** → New file or first install → treat as new
 * 3. **Apply logic:**
 *    - Update unchanged files with new defaults
 *    - Skip/prompt for files you've customized
 *    - Create backups before updating
 *
 * ## File Categories
 *
 * ### Workspace defaults (tracked by manifest)
 *
 * These files are tracked and intelligently upgraded:
 *
 * - `AGENTS.md` — Architecture and conventions
 * - `HEARTBEAT.md` — Scheduler documentation
 * - `IDENTITY.md` — Agent identity
 * - `TOOLS.md` — Tool reference
 * - `devclaw/workflow.yaml` — Pipeline configuration
 * - `devclaw/prompts/developer.md` — Developer role instructions
 * - `devclaw/prompts/tester.md` — Tester role instructions
 * - `devclaw/prompts/reviewer.md` — Reviewer role instructions
 * - `devclaw/prompts/architect.md` — Architect role instructions
 *
 * ### Never tracked
 *
 * These files are never touched by `upgrade-defaults`:
 *
 * - `devclaw/projects/<name>/prompts/*.md` — Project-level overrides (your customizations)
 * - `devclaw/projects.json` — Runtime state
 * - `.INSTALLED_DEFAULTS` — The manifest itself
 * - User-created files in workspace
 *
 * ## Lifecycle
 *
 * ### First Install
 *
 * When DevClaw is first installed or `reset_defaults` is run:
 *
 * 1. Default files are written to workspace
 * 2. Manifest is created with current hashes and timestamp
 *
 * Example after first install:
 * ```bash
 * ls -la workspace/.INSTALLED_DEFAULTS
 * # -rw-r--r-- 1 user user 2456 Feb 22 13:25 .INSTALLED_DEFAULTS
 * ```
 *
 * ### Upgrade with `upgrade-defaults`
 *
 * When a new version of DevClaw is released:
 *
 * 1. **Preview** — Compare new default hashes to manifest
 * 2. **Apply** — Update unchanged files, skip customized ones
 * 3. **Update manifest** — Recompute hashes for updated files, preserve timestamps for skipped files
 * 4. **Rollback info** — Store previous manifest as `.INSTALLED_DEFAULTS.bak`
 *
 * Example after upgrade:
 * ```json
 * {
 *   "AGENTS.md": {
 *     "hash": "abc123... (new)",
 *     "timestamp": 1708651200
 *   },
 *   "devclaw/workflow.yaml": {
 *     "hash": "def456... (unchanged from before)",
 *     "timestamp": 1708564800
 *   }
 * }
 * ```
 *
 * ### User Edit + Upgrade
 *
 * If you edit `AGENTS.md` and then upgrade:
 *
 * 1. Old manifest: `AGENTS.md → hash:abc123`
 * 2. You edit: file now has `hash:xyz789`
 * 3. New defaults: default `hash:abc123` → `hash:def456`
 * 4. Comparison: current `xyz789` ≠ manifest `abc123` → **customized**
 * 5. Action: **skip** (preserve your changes) or **merge**
 *
 * Your edits are always protected.
 *
 * ### Rollback
 *
 * If you upgrade and something goes wrong:
 *
 * 1. Previous state backed up as `.INSTALLED_DEFAULTS.bak`
 * 2. Run `upgrade-defaults --rollback`
 * 3. All files restored to pre-upgrade state
 * 4. Manifest restored to previous version
 *
 * ## Hash Computation
 *
 * All hashes are computed as **SHA256 of UTF-8 file content**:
 *
 * ```typescript
 * const hash = crypto
 *   .createHash("sha256")
 *   .update(content, "utf-8")
 *   .digest("hex");
 * ```
 *
 * This ensures:
 * - Same file content = same hash (deterministic)
 * - Different encoding = different hash (whitespace matters)
 * - No false positives (SHA256 collision probability is negligible)
 *
 * Example:
 * ```bash
 * # Compute hash of AGENTS.md
 * sha256sum AGENTS.md
 * # e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  AGENTS.md
 * ```
 *
 * ## Manifest Staleness
 *
 * If the manifest is very old (>6 months), `upgrade-defaults` may recommend
 * `reset_defaults` to re-baseline:
 *
 * ```
 * ⚠️  Manifest is 6+ months old. Consider reset_defaults to re-baseline.
 * Run: reset_defaults (for hard reset)
 * Or: upgrade-defaults --force (to upgrade anyway)
 * ```
 *
 * This prevents stale hashes from accidentally skipping important updates.
 *
 * ## API
 *
 * Functions for working with the manifest:
 *
 * - `readManifest(workspaceDir)` — Load `.INSTALLED_DEFAULTS`
 * - `writeManifest(workspaceDir, manifest)` — Save manifest
 * - `computeHash(content)` — Compute SHA256 of file content
 * - `detectCustomization(filePath, manifest, relPath)` — Check if file is customized
 *
 * See `upgrade-defaults.ts` for implementation examples.
 *
 * ## Troubleshooting
 *
 * **Q: ".INSTALLED_DEFAULTS doesn't exist"**
 * A: Manifest is auto-created on first `upgrade-defaults --auto` run.
 *    Until then, `reset_defaults` is the only option.
 *
 * **Q: "Hash mismatch — how do I fix it?"**
 * A: Check if you edited the file. If not, run `reset_defaults` to re-baseline.
 *
 * **Q: "Can I manually edit the manifest?"**
 * A: Not recommended. The tool manages it automatically. If corrupted, delete it
 *    and run `reset_defaults` to re-create.
 *
 * **Q: "What if two people edit the manifest?"**
 * A: Last write wins. Each `upgrade-defaults` run overwrites the manifest.
 *    Team coordination recommended.
 *
 * See UPGRADE.md for user guide and AGENTS.md for architecture overview.
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Default files that are tracked by the manifest.
 * These paths are relative to the workspace root.
 */
export const TRACKED_DEFAULT_FILES = [
  "AGENTS.md",
  "HEARTBEAT.md",
  "IDENTITY.md",
  "TOOLS.md",
  "devclaw/workflow.yaml",
  "devclaw/prompts/developer.md",
  "devclaw/prompts/tester.md",
  "devclaw/prompts/reviewer.md",
  "devclaw/prompts/architect.md",
];

/**
 * Manifest entry for a single tracked file.
 */
export interface ManifestEntry {
  /** SHA256 hash of the file content when installed/upgraded */
  hash: string;
  /** Unix timestamp of installation/upgrade */
  timestamp: number;
}

/**
 * The `.INSTALLED_DEFAULTS` manifest structure.
 * Maps relative file path → {hash, timestamp}.
 */
export type Manifest = Record<string, ManifestEntry>;

/**
 * Reads the `.INSTALLED_DEFAULTS` manifest from the workspace.
 *
 * @param workspaceDir — Workspace directory path
 * @returns Manifest object, or empty object if manifest doesn't exist yet
 */
export async function readManifest(workspaceDir: string): Promise<Manifest> {
  const manifestPath = path.join(workspaceDir, ".INSTALLED_DEFAULTS");
  try {
    const content = await fs.readFile(manifestPath, "utf-8");
    return JSON.parse(content) as Manifest;
  } catch {
    // Manifest doesn't exist yet — return empty object
    return {};
  }
}

/**
 * Writes the `.INSTALLED_DEFAULTS` manifest to the workspace.
 *
 * @param workspaceDir — Workspace directory path
 * @param manifest — Manifest object to write
 */
export async function writeManifest(workspaceDir: string, manifest: Manifest): Promise<void> {
  const manifestPath = path.join(workspaceDir, ".INSTALLED_DEFAULTS");
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
}

/**
 * Computes SHA256 hash of file content.
 *
 * @param content — File content as string
 * @returns SHA256 hash in hex format
 */
export function computeHash(content: string): string {
  return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
}

/**
 * Customization detection result.
 */
export type CustomizationStatus = "unchanged" | "customized" | "new";

/**
 * Detects whether a file has been customized by comparing its current hash
 * to the stored default hash in the manifest.
 *
 * Logic:
 * - File doesn't exist → "new"
 * - File has no manifest entry → "new" (first install)
 * - Current hash equals stored hash → "unchanged" (safe to update)
 * - Current hash differs from stored hash → "customized" (skip or merge)
 *
 * @param filePath — Full path to the file
 * @param manifest — Installed defaults manifest
 * @param relPath — Relative file path (key in manifest)
 * @returns Customization status
 */
export async function detectCustomization(
  filePath: string,
  manifest: Manifest,
  relPath: string,
): Promise<CustomizationStatus> {
  // File doesn't exist yet
  try {
    await fs.access(filePath);
  } catch {
    return "new";
  }

  // No entry in manifest (first install)
  if (!manifest[relPath]) {
    return "new";
  }

  // Compare hashes
  const content = await fs.readFile(filePath, "utf-8");
  const currentHash = computeHash(content);
  const storedHash = manifest[relPath].hash;

  return currentHash === storedHash ? "unchanged" : "customized";
}

/**
 * Checks if the manifest is stale (older than maxAgeDays).
 * Used to recommend re-baselining when manifest is very old.
 *
 * @param manifest — Manifest object
 * @param maxAgeDays — Maximum age in days (default: 180)
 * @returns true if any entry is older than maxAgeDays
 */
export function isManifestStale(manifest: Manifest, maxAgeDays: number = 180): boolean {
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  for (const entry of Object.values(manifest)) {
    const ageMs = now - entry.timestamp * 1000;
    if (ageMs > maxAgeMs) {
      return true;
    }
  }

  return false;
}
