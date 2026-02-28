/**
 * config — Config management tool for DevClaw workspaces.
 *
 * Subcommands:
 * - reset: Reset config files to package defaults (with .bak backups)
 * - diff: Show differences between current workflow.yaml and package default
 * - version: Show current and workspace DevClaw versions
 */
import fs from "node:fs/promises";
import path from "node:path";
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../../types.js";
import type { PluginContext } from "../../context.js";
import { writeAllDefaults, backupAndWrite, fileExists } from "../../setup/workspace.js";
import { WORKFLOW_YAML_TEMPLATE, DEFAULT_ROLE_INSTRUCTIONS } from "../../setup/templates.js";
import { DATA_DIR } from "../../setup/migrate-layout.js";
import { getCurrentVersion, readVersionFile } from "../../setup/version.js";

export function createConfigTool(ctx: PluginContext) {
  return (toolCtx: ToolContext) => ({
    name: "config",
    label: "Config",
    description: `Manage DevClaw workspace configuration.

Actions:
- **reset**: Reset config files to package defaults. Creates .bak backups of existing files.
  Scope: --prompts (prompts only), --workflow (workflow.yaml only), --all (everything).
- **diff**: Show differences between current workflow.yaml and the package default template.
- **version**: Show DevClaw package version and workspace tracked version.

Examples:
  config({ action: "reset", scope: "workflow" })
  config({ action: "reset", scope: "all" })
  config({ action: "diff" })
  config({ action: "version" })`,
    parameters: {
      type: "object",
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: ["reset", "diff", "version"],
          description: "Config action to perform.",
        },
        scope: {
          type: "string",
          enum: ["prompts", "workflow", "all"],
          description: "Scope for reset action. Default: all.",
        },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const action = params.action as string;
      const workspacePath = toolCtx.workspaceDir;
      if (!workspacePath) throw new Error("No workspace directory available");

      switch (action) {
        case "reset":
          return await handleReset(workspacePath, (params.scope as string) ?? "all");
        case "diff":
          return await handleDiff(workspacePath);
        case "version":
          return await handleVersion(workspacePath);
        default:
          throw new Error(`Unknown config action: ${action}`);
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleReset(workspacePath: string, scope: string) {
  const dataDir = path.join(workspacePath, DATA_DIR);
  const written: string[] = [];

  if (scope === "all") {
    const files = await writeAllDefaults(workspacePath, true);
    written.push(...files);
  } else if (scope === "workflow") {
    const workflowPath = path.join(dataDir, "workflow.yaml");
    await backupAndWrite(workflowPath, WORKFLOW_YAML_TEMPLATE);
    written.push("devclaw/workflow.yaml");
  } else if (scope === "prompts") {
    const promptsDir = path.join(dataDir, "prompts");
    for (const [role, content] of Object.entries(DEFAULT_ROLE_INSTRUCTIONS)) {
      if (!content) continue;
      const rolePath = path.join(promptsDir, `${role}.md`);
      await backupAndWrite(rolePath, content);
      written.push(`devclaw/prompts/${role}.md`);
    }
  } else {
    throw new Error(`Unknown scope: ${scope}. Use: prompts, workflow, or all.`);
  }

  return jsonResult({
    success: true,
    action: "reset",
    scope,
    filesWritten: written,
    summary: written.length > 0
      ? `Reset ${written.length} file(s) to package defaults (.bak backups created):\n${written.map(f => `  ${f}`).join("\n")}`
      : "No files to reset.",
  });
}

async function handleDiff(workspacePath: string) {
  const workflowPath = path.join(workspacePath, DATA_DIR, "workflow.yaml");

  if (!await fileExists(workflowPath)) {
    return jsonResult({
      success: true,
      action: "diff",
      summary: "No workflow.yaml found in workspace — using package defaults.",
    });
  }

  const current = await fs.readFile(workflowPath, "utf-8");
  const template = WORKFLOW_YAML_TEMPLATE;

  if (current.trim() === template.trim()) {
    return jsonResult({
      success: true,
      action: "diff",
      summary: "workflow.yaml matches the package default — no differences.",
    });
  }

  // Simple line-by-line diff
  const currentLines = current.split("\n");
  const templateLines = template.split("\n");
  const diffs: string[] = [];

  const maxLen = Math.max(currentLines.length, templateLines.length);
  for (let i = 0; i < maxLen; i++) {
    const cl = currentLines[i] ?? "";
    const tl = templateLines[i] ?? "";
    if (cl !== tl) {
      if (tl && !cl) diffs.push(`+${i + 1}: ${tl}`);
      else if (cl && !tl) diffs.push(`-${i + 1}: ${cl}`);
      else {
        diffs.push(`-${i + 1}: ${cl}`);
        diffs.push(`+${i + 1}: ${tl}`);
      }
    }
  }

  return jsonResult({
    success: true,
    action: "diff",
    differences: diffs.length,
    summary: `workflow.yaml differs from package default (${diffs.length} line(s)):\n\`\`\`diff\n${diffs.join("\n")}\n\`\`\`\n\nUse \`config({ action: "reset", scope: "workflow" })\` to reset to defaults.`,
  });
}

async function handleVersion(workspacePath: string) {
  const packageVersion = getCurrentVersion();
  const dataDir = path.join(workspacePath, DATA_DIR);
  const workspaceVersion = await readVersionFile(dataDir);

  const match = workspaceVersion === packageVersion;

  return jsonResult({
    success: true,
    action: "version",
    packageVersion,
    workspaceVersion: workspaceVersion ?? "(not tracked)",
    match,
    summary: match
      ? `DevClaw v${packageVersion} — workspace up to date.`
      : workspaceVersion
        ? `DevClaw v${packageVersion} (workspace tracked: v${workspaceVersion}) — version mismatch.`
        : `DevClaw v${packageVersion} — workspace version not yet tracked.`,
  });
}
