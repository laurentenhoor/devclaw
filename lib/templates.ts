/**
 * Shared templates for workspace files.
 * Used by setup and project_register.
 *
 * All templates are loaded from defaults/ at the repo root.
 * These files serve as both documentation and the runtime source of truth.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// ---------------------------------------------------------------------------
// File loader — reads from defaults/ (single source of truth)
// ---------------------------------------------------------------------------

const DEFAULTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "defaults");

/**
 * Manifest of all default files with SHA256 hashes.
 * Used for version tracking and detecting customizations.
 */
export type DefaultsManifest = {
  version: string;
  createdAt: string;
  files: Record<string, { hash: string; updatedAt: string }>;
};

/**
 * Load the DEFAULTS.json manifest from the plugin defaults directory.
 * This manifest contains SHA256 hashes of all default files for version tracking.
 */
export function loadDefaultsManifest(): DefaultsManifest | null {
  try {
    const manifestPath = path.join(DEFAULTS_DIR, "DEFAULTS.json");
    const content = fs.readFileSync(manifestPath, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function loadDefault(filename: string, fallback = ""): string {
  try {
    return fs.readFileSync(path.join(DEFAULTS_DIR, filename), "utf-8");
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Role prompts — defaults/developer.md, defaults/tester.md, etc.
// ---------------------------------------------------------------------------

export const DEFAULT_DEV_INSTRUCTIONS = loadDefault("devclaw/prompts/developer.md", "# DEVELOPER Worker Instructions\n\nAdd role-specific instructions here.\n");
export const DEFAULT_QA_INSTRUCTIONS = loadDefault("devclaw/prompts/tester.md", "# TESTER Worker Instructions\n\nAdd role-specific instructions here.\n");
export const DEFAULT_ARCHITECT_INSTRUCTIONS = loadDefault("devclaw/prompts/architect.md", "# ARCHITECT Worker Instructions\n\nAdd role-specific instructions here.\n");
export const DEFAULT_REVIEWER_INSTRUCTIONS = loadDefault("devclaw/prompts/reviewer.md", "# REVIEWER Worker Instructions\n\nAdd role-specific instructions here.\n");

/** Default role instructions indexed by role ID. Used by project scaffolding. */
export const DEFAULT_ROLE_INSTRUCTIONS: Record<string, string> = {
  developer: DEFAULT_DEV_INSTRUCTIONS,
  tester: DEFAULT_QA_INSTRUCTIONS,
  architect: DEFAULT_ARCHITECT_INSTRUCTIONS,
  reviewer: DEFAULT_REVIEWER_INSTRUCTIONS,
};

// ---------------------------------------------------------------------------
// Workspace templates — defaults/AGENTS.md, defaults/SOUL.md, etc.
// ---------------------------------------------------------------------------

export const AGENTS_MD_TEMPLATE = loadDefault("AGENTS.md");
export const HEARTBEAT_MD_TEMPLATE = loadDefault("HEARTBEAT.md");
export const IDENTITY_MD_TEMPLATE = loadDefault("IDENTITY.md");
export const SOUL_MD_TEMPLATE = loadDefault("SOUL.md");
export const TOOLS_MD_TEMPLATE = loadDefault("TOOLS.md");

// ---------------------------------------------------------------------------
// Workflow YAML — roles generated from registry + workflow section from file
// ---------------------------------------------------------------------------

export const WORKFLOW_YAML_TEMPLATE = loadDefault("devclaw/workflow.yaml");
