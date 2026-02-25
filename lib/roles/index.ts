/**
 * roles/ — Centralized role configuration.
 *
 * Single source of truth for all worker roles in DevClaw.
 * To add a new role, add an entry to registry.ts — everything else derives from it.
 */
export { ROLE_REGISTRY } from "./registry.js";
export type { RoleConfig } from "./types.js";
export {
  // Role IDs
  getAllRoleIds,
  isValidRole,
  getRole,
  requireRole,
  // Role/level aliases (used by migration + tests)
  canonicalLevel,
  // Levels
  getLevelsForRole,
  getAllLevels,
  isLevelForRole,
  roleForLevel,
  getDefaultLevel,
  // Models
  getDefaultModel,
  getAllDefaultModels,
  resolveModel,
  // Emoji
  getEmoji,
  getFallbackEmoji,
  // Completion
  getCompletionResults,
  isValidResult,
  // Session keys
  getSessionKeyRolePattern,
} from "./selectors.js";
