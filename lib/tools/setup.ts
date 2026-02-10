/**
 * setup — Agent-driven DevClaw setup.
 *
 * Creates agent, configures model levels, writes workspace files.
 * Thin wrapper around lib/setup/.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../types.js";
import { runSetup, type SetupOpts } from "../setup/index.js";
import { DEV_LEVELS, QA_LEVELS, DEFAULT_MODELS } from "../tiers.js";

export function createSetupTool(api: OpenClawPluginApi) {
  return (ctx: ToolContext) => ({
    name: "setup",
    label: "Setup",
    description: `Execute DevClaw setup. Creates AGENTS.md, HEARTBEAT.md, projects/projects.json, and model level config. Optionally creates a new agent with channel binding. Called after onboard collects configuration.`,
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
          properties: {
            dev: {
              type: "object",
              description: "Developer level models",
              properties: {
                junior: {
                  type: "string",
                  description: `Default: ${DEFAULT_MODELS.dev.junior}`,
                },
                medior: {
                  type: "string",
                  description: `Default: ${DEFAULT_MODELS.dev.medior}`,
                },
                senior: {
                  type: "string",
                  description: `Default: ${DEFAULT_MODELS.dev.senior}`,
                },
              },
            },
            qa: {
              type: "object",
              description: "QA level models",
              properties: {
                reviewer: {
                  type: "string",
                  description: `Default: ${DEFAULT_MODELS.qa.reviewer}`,
                },
                tester: {
                  type: "string",
                  description: `Default: ${DEFAULT_MODELS.qa.tester}`,
                },
              },
            },
          },
        },
        projectExecution: {
          type: "string",
          enum: ["parallel", "sequential"],
          description: "Project execution mode. Default: parallel.",
        },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const result = await runSetup({
        newAgentName: params.newAgentName as string | undefined,
        channelBinding:
          (params.channelBinding as "telegram" | "whatsapp") ?? null,
        migrateFrom: params.migrateFrom as string | undefined,
        agentId: params.newAgentName ? undefined : ctx.agentId,
        workspacePath: params.newAgentName ? undefined : ctx.workspaceDir,
        models: params.models as SetupOpts["models"],
        projectExecution: params.projectExecution as
          | "parallel"
          | "sequential"
          | undefined,
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
      lines.push(
        "Models:",
        ...DEV_LEVELS.map((t) => `  dev.${t}: ${result.models.dev[t]}`),
        ...QA_LEVELS.map((t) => `  qa.${t}: ${result.models.qa[t]}`),
        "",
        "Files:",
        ...result.filesWritten.map((f) => `  ${f}`),
      );
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
