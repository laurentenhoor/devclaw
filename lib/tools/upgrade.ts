/**
 * upgrade — Upgrade DevClaw plugin and workspace files.
 *
 * Checks npm for a newer published version and installs it.
 * Then upgrades workspace files (docs, prompts, workflow states) to match
 * the running version, with .bak backups. Preserves user customizations
 * in roles/timeouts and project-level prompt overrides.
 */
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../types.js";
import { requireWorkspaceDir } from "../tool-helpers.js";
import {
  PLUGIN_VERSION,
  upgradeWorkspaceIfNeeded,
  checkAndInstallUpdate,
} from "../upgrade.js";

export function createUpgradeTool() {
  return (ctx: ToolContext) => ({
    name: "upgrade",
    label: "Upgrade",
    description:
      `Upgrade DevClaw plugin and workspace files. ` +
      `Checks npm for a newer version and installs it via 'openclaw plugins install'. ` +
      `Then upgrades workspace docs, default prompts, and workflow states to match ` +
      `the running version (with .bak backups). Preserves roles, timeouts, and ` +
      `project-level prompt overrides.`,
    parameters: {
      type: "object",
      properties: {
        skipNpmCheck: {
          type: "boolean",
          description:
            "Skip the npm version check and only upgrade workspace files. Default: false.",
        },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const workspaceDir = requireWorkspaceDir(ctx);
      const skipNpmCheck = (params.skipNpmCheck as boolean) ?? false;

      const logger = {
        info: (_msg: string) => {},
        warn: (_msg: string) => {},
      };
      const messages: string[] = [];
      const logCapture = {
        info: (msg: string) => { messages.push(msg); },
        warn: (msg: string) => { messages.push(`[warn] ${msg}`); },
      };

      // 1. Check npm for newer version and install
      let npmUpdate: string | null = null;
      if (!skipNpmCheck) {
        npmUpdate = await checkAndInstallUpdate(logCapture);
      }

      // 2. Upgrade workspace files if version stamp differs
      const result = await upgradeWorkspaceIfNeeded(workspaceDir, logCapture);

      return jsonResult({
        currentVersion: PLUGIN_VERSION,
        npmUpdate: npmUpdate
          ? { installed: npmUpdate, note: "Restart the gateway to activate the new version." }
          : { status: "up to date" },
        workspaceUpgrade: result.upgraded
          ? { status: "upgraded", details: messages.filter(m => !m.includes("npm") && !m.includes("Installing")) }
          : { status: "already up to date" },
        skippedPrompts: result.skippedPrompts.length > 0
          ? {
            files: result.skippedPrompts.map(r => `devclaw/prompts/${r}.md`),
            note: "These prompt files were customized and NOT updated. Run reset_defaults to get the latest defaults (creates .bak backups).",
          }
          : undefined,
        messages,
      });
    },
  });
}
