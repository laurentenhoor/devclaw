/**
 * config_diff — Show differences between user's workflow.yaml and the built-in default.
 *
 * Outputs a human-readable comparison so users can see what changed
 * in new versions and what they've customized.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../../types.js";
import type { PluginContext } from "../../context.js";
import { requireWorkspaceDir } from "../helpers.js";
import { WORKFLOW_YAML_TEMPLATE } from "../../setup/templates.js";
import { DATA_DIR } from "../../setup/migrate-layout.js";

export function createConfigDiffTool(_ctx: PluginContext) {
  return (toolCtx: ToolContext) => ({
    name: "config_diff",
    label: "Config Diff",
    description:
      "Show differences between your workflow.yaml and the built-in default template. " +
      "Helps identify customizations and see what changed in new DevClaw versions.",
    parameters: {
      type: "object",
      properties: {
        channelId: {
          type: "string",
          description: "YOUR chat/group ID.",
        },
      },
      required: ["channelId"],
    },
    execute: async (_params: Record<string, unknown>) => {
      const workspaceDir = requireWorkspaceDir(toolCtx);
      const workflowPath = path.join(workspaceDir, DATA_DIR, "workflow.yaml");

      let userContent: string;
      try {
        userContent = await fs.readFile(workflowPath, "utf-8");
      } catch {
        return jsonResult({
          status: "no_file",
          message: "No workflow.yaml found. Run setup to create one.",
        });
      }

      const defaultContent = WORKFLOW_YAML_TEMPLATE;

      if (userContent.trim() === defaultContent.trim()) {
        return jsonResult({
          status: "identical",
          message: "Your workflow.yaml matches the built-in default — no customizations.",
        });
      }

      // Build a simple line-by-line diff
      const userLines = userContent.split("\n");
      const defaultLines = defaultContent.split("\n");
      const diffs: string[] = [];

      const maxLen = Math.max(userLines.length, defaultLines.length);
      for (let i = 0; i < maxLen; i++) {
        const uLine = userLines[i] ?? "";
        const dLine = defaultLines[i] ?? "";
        if (uLine !== dLine) {
          if (dLine && uLine) {
            diffs.push(`Line ${i + 1}:`);
            diffs.push(`  - default: ${dLine}`);
            diffs.push(`  + yours:   ${uLine}`);
          } else if (dLine && !uLine) {
            diffs.push(`Line ${i + 1} (removed):`);
            diffs.push(`  - default: ${dLine}`);
          } else {
            diffs.push(`Line ${i + 1} (added):`);
            diffs.push(`  + yours:   ${uLine}`);
          }
        }
      }

      return jsonResult({
        status: "different",
        differences: diffs.join("\n"),
        message: `Found ${diffs.filter(d => d.startsWith("Line")).length} difference(s) between your workflow.yaml and the default.`,
      });
    },
  });
}
