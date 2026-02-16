/**
 * config/merge.ts — Deep merge for DevClaw config layers.
 *
 * Merge semantics:
 * - Objects: recursively merge (sparse override)
 * - Arrays: replace entirely (no merging array elements)
 * - `false` for a role: marks it as disabled
 * - Primitives: override
 */
import type { DevClawConfig, RoleOverride } from "./types.js";

/**
 * Merge a config overlay on top of a base config.
 * Returns a new config — does not mutate inputs.
 */
export function mergeConfig(
  base: DevClawConfig,
  overlay: DevClawConfig,
): DevClawConfig {
  const merged: DevClawConfig = {};

  // Merge roles
  if (base.roles || overlay.roles) {
    merged.roles = { ...base.roles };
    if (overlay.roles) {
      for (const [roleId, overrideValue] of Object.entries(overlay.roles)) {
        if (overrideValue === false) {
          // Disable role
          merged.roles[roleId] = false;
        } else if (merged.roles[roleId] === false) {
          // Re-enable with override
          merged.roles[roleId] = overrideValue;
        } else {
          // Merge role override on top of base role
          const baseRole = merged.roles[roleId];
          merged.roles[roleId] = mergeRoleOverride(
            typeof baseRole === "object" ? baseRole : {},
            overrideValue,
          );
        }
      }
    }
  }

  // Merge workflow
  if (base.workflow || overlay.workflow) {
    merged.workflow = {
      initial: overlay.workflow?.initial ?? base.workflow?.initial,
      reviewPolicy: overlay.workflow?.reviewPolicy ?? base.workflow?.reviewPolicy,
      states: {
        ...base.workflow?.states,
        ...overlay.workflow?.states,
      },
    };
    // Clean up undefined initial
    if (merged.workflow.initial === undefined) {
      delete merged.workflow.initial;
    }
  }

  // Merge timeouts
  if (base.timeouts || overlay.timeouts) {
    merged.timeouts = { ...base.timeouts, ...overlay.timeouts };
  }

  return merged;
}

function mergeRoleOverride(
  base: RoleOverride,
  overlay: RoleOverride,
): RoleOverride {
  return {
    ...base,
    ...overlay,
    // Models: merge (don't replace)
    models: base.models || overlay.models
      ? { ...base.models, ...overlay.models }
      : undefined,
    // Emoji: merge (don't replace)
    emoji: base.emoji || overlay.emoji
      ? { ...base.emoji, ...overlay.emoji }
      : undefined,
    // Arrays replace entirely
    ...(overlay.levels ? { levels: overlay.levels } : {}),
    ...(overlay.completionResults ? { completionResults: overlay.completionResults } : {}),
  };
}
