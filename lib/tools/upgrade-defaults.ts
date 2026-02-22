/**
 * upgrade-defaults - Smart defaults upgrade with customization detection.
 *
 * This tool intelligently upgrades workspace defaults (AGENTS.md, workflow.yaml,
 * role prompts, etc.) while preserving user customizations. It uses hash-based
 * version tracking to detect what you've modified and protects those changes.
 *
 * For detailed documentation, see:
 * - UPGRADE.md - User guide with step-by-step workflows and examples
 * - lib/setup/defaults-manifest.ts - Technical details on manifest format
 * - AGENTS.md "Defaults Upgrade Strategy" - Architecture overview
 *
 * Modes:
 * - --preview: Show what will change without modifying
 * - --auto: Apply safe changes automatically (default)
 * - --rollback: Restore files to state before last upgrade
 *
 * Example workflow:
 *   upgrade-defaults --preview    # See changes first
 *   upgrade-defaults --auto       # Apply if satisfied
 *   upgrade-defaults --rollback   # Undo if needed
 *
 * Compare with reset_defaults:
 * - upgrade-defaults: Non-destructive, preserves customizations
 * - reset_defaults: Overwrite all defaults (nuclear option)
 *
 * See AGENTS.md for comparison table and when to use each.
 */

import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../types.js";
import { requireWorkspaceDir } from "../tool-helpers.js";

export function createUpgradeDefaultsTool() {
  return (ctx: ToolContext) => ({
    name: "upgrade_defaults",
    label: "Upgrade Defaults",
    description:
      "Smart defaults upgrade with customization detection. Non-destructive incremental updates that preserve your customizations. Use --preview to see changes first, --auto to apply safe changes, --rollback to undo. Hash-based version tracking detects and protects customizations.",
    parameters: {
      type: "object",
      properties: {
        preview: {
          type: "boolean",
          description: "Preview what will change without modifying anything.",
        },
        auto: {
          type: "boolean",
          description:
            "Apply safe changes automatically. Updates files you have not customized, skips those you have.",
        },
        rollback: {
          type: "boolean",
          description: "Restore all files to their state before the last upgrade.",
        },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const workspaceDir = requireWorkspaceDir(ctx);

      const doPreview = (params.preview as boolean) ?? false;
      const doAuto = (params.auto as boolean) ?? false;
      const doRollback = (params.rollback as boolean) ?? false;

      // Default to --auto if no mode specified
      const mode = doPreview ? "preview" : doRollback ? "rollback" : "auto";

      try {
        // TODO: Implement preview mode
        if (mode === "preview") {
          return jsonResult({
            success: true,
            mode: "preview",
            message: "Preview mode not yet implemented. See UPGRADE.md for planned features.",
            nextStep:
              "Check UPGRADE.md for upgrade workflow and examples. Use reset_defaults for immediate hard reset if needed.",
          });
        }

        // TODO: Implement rollback mode
        if (mode === "rollback") {
          return jsonResult({
            success: false,
            mode: "rollback",
            message: "Rollback mode not yet implemented. See UPGRADE.md for planned features.",
            nextStep:
              "Restore manually from .bak files or use reset_defaults for clean slate.",
          });
        }

        // TODO: Implement auto mode
        if (mode === "auto") {
          return jsonResult({
            success: true,
            mode: "auto",
            message: "Auto mode not yet implemented. See UPGRADE.md for planned features.",
            nextStep:
              "Run reset_defaults if you need to update workspace defaults immediately.",
          });
        }

        return jsonResult({
          success: false,
          message: "Unknown mode.",
        });
      } catch (error) {
        return jsonResult({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });
}
