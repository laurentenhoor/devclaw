/**
 * config/ — Unified DevClaw configuration.
 *
 * Single workflow.yaml per workspace/project combining roles, models, and workflow.
 */
export type {
  DevClawConfig,
  RoleOverride,
  ResolvedConfig,
  ResolvedRoleConfig,
} from "./types.js";

export { loadConfig } from "./loader.js";
export { mergeConfig } from "./merge.js";
