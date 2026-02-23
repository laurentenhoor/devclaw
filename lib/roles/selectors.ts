/**
 * roles/selectors.ts — Query helpers for the role registry.
 *
 * All role-related lookups go through these functions.
 * No other file should access ROLE_REGISTRY directly for role logic.
 */
import { ROLE_REGISTRY } from "./registry.js";
import type { RoleConfig } from "./types.js";
import type { ResolvedRoleConfig } from "../config/types.js";
import { ROLE_ALIASES as _ROLE_ALIASES, canonicalLevel as _canonicalLevel } from "../projects/migrations.js";

// ---------------------------------------------------------------------------
// Role IDs
// ---------------------------------------------------------------------------

/** All registered role IDs. */
export function getAllRoleIds(): string[] {
  return Object.keys(ROLE_REGISTRY);
}

/** The role ID union type, derived from registry. */
export type WorkerRole = keyof typeof ROLE_REGISTRY;

/** Check if a string is a valid role ID. */
export function isValidRole(role: string): boolean {
  return role in ROLE_REGISTRY;
}

/** Get role config by ID. Returns undefined if not found. */
export function getRole(role: string): RoleConfig | undefined {
  return ROLE_REGISTRY[role];
}

/** Get role config by ID. Throws if not found. */
export function requireRole(role: string): RoleConfig {
  const config = ROLE_REGISTRY[role];
  if (!config) throw new Error(`Unknown role: "${role}". Valid roles: ${getAllRoleIds().join(", ")}`);
  return config;
}

// ---------------------------------------------------------------------------
// Migration aliases — re-exported from lib/migrations.ts for backward compat
// ---------------------------------------------------------------------------

export { ROLE_ALIASES, canonicalRole, LEVEL_ALIASES, canonicalLevel } from "../projects/migrations.js";

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

/** Get valid levels for a role. */
export function getLevelsForRole(role: string): readonly string[] {
  return getRole(role)?.levels ?? [];
}

/** Get all levels across all roles. */
export function getAllLevels(): string[] {
  return Object.values(ROLE_REGISTRY).flatMap(r => [...r.levels]);
}

/** Check if a level belongs to a specific role. */
export function isLevelForRole(level: string, role: string): boolean {
  return getLevelsForRole(role).includes(level);
}

/** Determine which role a level belongs to. Returns undefined if no match. */
export function roleForLevel(level: string): string | undefined {
  for (const [roleId, config] of Object.entries(ROLE_REGISTRY)) {
    if (config.levels.includes(level)) return roleId;
  }
  return undefined;
}

/** Get the default level for a role. */
export function getDefaultLevel(role: string): string | undefined {
  return getRole(role)?.defaultLevel;
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/** Get default model for a role + level. */
export function getDefaultModel(role: string, level: string): string | undefined {
  return getRole(role)?.models[level];
}

/** Get all default models, nested by role (for config schema). */
export function getAllDefaultModels(): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  for (const [roleId, config] of Object.entries(ROLE_REGISTRY)) {
    result[roleId] = { ...config.models };
  }
  return result;
}

/**
 * Resolve a level to a full model ID.
 *
 * Resolution order:
 * 1. Resolved config from workflow.yaml (three-layer merge)
 * 2. Registry default model
 * 3. Passthrough (treat level as raw model ID)
 */
export function resolveModel(
  role: string,
  level: string,
  resolvedRole?: ResolvedRoleConfig,
): string {
  const canonical = _canonicalLevel(role, level);

  // 1. Resolved config (workflow.yaml — includes workspace + project overrides)
  if (resolvedRole?.models[canonical]) return resolvedRole.models[canonical];

  // 2. Built-in registry default
  return getDefaultModel(role, canonical) ?? canonical;
}

// ---------------------------------------------------------------------------
// Emoji
// ---------------------------------------------------------------------------

/** Get emoji for a role + level. */
export function getEmoji(role: string, level: string): string | undefined {
  return getRole(role)?.emoji[level];
}

/** Get fallback emoji for a role. */
export function getFallbackEmoji(role: string): string {
  return getRole(role)?.fallbackEmoji ?? "📋";
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

/** Get valid completion results for a role. */
export function getCompletionResults(role: string): readonly string[] {
  return getRole(role)?.completionResults ?? [];
}

/** Check if a result is valid for a role. */
export function isValidResult(role: string, result: string): boolean {
  return getCompletionResults(role).includes(result);
}

// ---------------------------------------------------------------------------
// Session keys
// ---------------------------------------------------------------------------

/** Build regex pattern that matches any registered role in session keys. */
export function getSessionKeyRolePattern(): string {
  return Object.values(ROLE_REGISTRY).map(r => r.sessionKeyPattern).join("|");
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/** Check if a role has a specific notification enabled. */
export function isNotificationEnabled(
  role: string,
  event: "onStart" | "onComplete",
): boolean {
  return getRole(role)?.notifications[event] ?? true;
}
