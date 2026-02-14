/**
 * tiers.ts — Developer level definitions and model resolution.
 *
 * This module now delegates to the centralized role registry (lib/roles/).
 * Kept for backward compatibility — new code should import from lib/roles/ directly.
 *
 * Level names are plain: "junior", "senior", "reviewer", etc.
 * Role context (dev/qa/architect) is always provided by the caller.
 */
import {
  type WorkerRole,
  ROLE_REGISTRY,
  getLevelsForRole,
  getAllDefaultModels,
  roleForLevel,
  getDefaultModel,
  getEmoji,
  resolveModel as registryResolveModel,
} from "./roles/index.js";

// Re-export WorkerRole from the registry
export type { WorkerRole };

// ---------------------------------------------------------------------------
// Level constants — derived from registry
// ---------------------------------------------------------------------------

/** @deprecated Use roles/selectors.getAllDefaultModels() */
export const DEFAULT_MODELS = getAllDefaultModels();

/** @deprecated Use roles/selectors.getEmoji() */
export const LEVEL_EMOJI: Record<string, Record<string, string>> = Object.fromEntries(
  Object.entries(ROLE_REGISTRY).map(([id, config]) => [id, { ...config.emoji }]),
);

export const DEV_LEVELS = getLevelsForRole("dev") as readonly string[];
export const QA_LEVELS = getLevelsForRole("qa") as readonly string[];
export const ARCHITECT_LEVELS = getLevelsForRole("architect") as readonly string[];

export type DevLevel = string;
export type QaLevel = string;
export type ArchitectLevel = string;
export type Level = string;

// ---------------------------------------------------------------------------
// Level checks — delegate to registry
// ---------------------------------------------------------------------------

/** Check if a level belongs to the dev role. */
export function isDevLevel(value: string): boolean {
  return DEV_LEVELS.includes(value);
}

/** Check if a level belongs to the qa role. */
export function isQaLevel(value: string): boolean {
  return QA_LEVELS.includes(value);
}

/** Check if a level belongs to the architect role. */
export function isArchitectLevel(value: string): boolean {
  return ARCHITECT_LEVELS.includes(value);
}

/** Determine the role a level belongs to. */
export function levelRole(level: string): WorkerRole | undefined {
  return roleForLevel(level) as WorkerRole | undefined;
}

// ---------------------------------------------------------------------------
// Model + emoji — delegate to registry
// ---------------------------------------------------------------------------

/** @deprecated Use roles/selectors.getDefaultModel() */
export function defaultModel(role: WorkerRole, level: string): string | undefined {
  return getDefaultModel(role, level);
}

/** @deprecated Use roles/selectors.getEmoji() */
export function levelEmoji(role: WorkerRole, level: string): string | undefined {
  return getEmoji(role, level);
}

/** @deprecated Use roles/selectors.resolveModel() */
export function resolveModel(
  role: WorkerRole,
  level: string,
  pluginConfig?: Record<string, unknown>,
): string {
  return registryResolveModel(role, level, pluginConfig);
}
