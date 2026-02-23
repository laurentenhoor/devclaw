/**
 * setup — Agent-driven DevClaw setup.
 *
 * Creates agent, configures model levels, writes workspace files.
 * Thin wrapper around lib/setup/.
 */
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../../types.js";
import type { PluginContext } from "../../context.js";
import { runSetup, type SetupOpts } from "../../setup/index.js";
import { getAllDefaultModels, getAllRoleIds, getLevelsForRole } from "../../roles/index.js";
import { ExecutionMode } from "../../workflow/index.js";

export function createSetupTool(ctx: PluginContext) {
  return (toolCtx: ToolContext) => ({
    name: "setup",
    label: "Setup",
    description: `Execute DevClaw setup. Creates AGENTS.md, HEARTBEAT.md, TOOLS.md, devclaw/projects.json, devclaw/prompts/, and model level config. Optionally creates a new agent with channel binding. Called after onboard collects configuration.`,
    parameters: {
      type: "object",
      properties: {
        newAgentName: {
          type: "string",
          description:
            "Create a new agent. Omit to configure current workspace.",
        },
        channelBinding: {
          type: "string",
          enum: ["telegram", "whatsapp"],
          description: "Channel to bind (optional, with newAgentName only).",
        },
        migrateFrom: {
          type: "string",
          description:
            "Agent ID to migrate channel binding from. Check openclaw.json bindings first.",
        },
        models: {
          type: "object",
          description: "Model overrides per role and level.",
          properties: Object.fromEntries(
            getAllRoleIds().map((role) => [role, {
              type: "object",
              description: `${role.toUpperCase()} level models`,
              properties: Object.fromEntries(
                getLevelsForRole(role).map((level) => [level, {
                  type: "string",
                  description: `Default: ${getAllDefaultModels()[role]?.[level] ?? "auto"}`,
                }]),
              ),
            }]),
          ),
        },
        projectExecution: {
          type: "string",
          enum: Object.values(ExecutionMode),
          description: "Project execution mode. Default: parallel.",
        },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const result = await runSetup({
        runtime: ctx.runtime,
        newAgentName: params.newAgentName as string | undefined,
        channelBinding:
          (params.channelBinding as "telegram" | "whatsapp") ?? null,
        migrateFrom: params.migrateFrom as string | undefined,
        agentId: params.newAgentName ? undefined : toolCtx.agentId,
        workspacePath: params.newAgentName ? undefined : toolCtx.workspaceDir,
        models: params.models as SetupOpts["models"],
        projectExecution: params.projectExecution as
          | ExecutionMode
          | undefined,
        runCommand: ctx.runCommand,
      });

      const lines = [
        result.agentCreated
          ? `Agent "${result.agentId}" created`
          : `Configured "${result.agentId}"`,
        "",
      ];
      if (result.bindingMigrated) {
        lines.push(
          `✅ Binding migrated: ${result.bindingMigrated.channel} (${result.bindingMigrated.from} → ${result.agentId})`,
          "",
        );
      }
      lines.push("Models:");
      for (const [role, levels] of Object.entries(result.models)) {
        for (const [level, model] of Object.entries(levels)) {
          lines.push(`  ${role}.${level}: ${model}`);
        }
      }
      lines.push("");

      lines.push("Files:", ...result.filesWritten.map((f) => `  ${f}`));

      if (result.warnings.length > 0)
        lines.push("", "Warnings:", ...result.warnings.map((w) => `  ${w}`));
      lines.push(
        "",
        "Next: register a project, then create issues and pick them up.",
      );

      return jsonResult({
        success: true,
        ...result,
        summary: lines.join("\n"),
      });
    },
  });
}
