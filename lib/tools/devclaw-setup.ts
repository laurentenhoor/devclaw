/**
 * devclaw_setup — Agent-driven setup tool.
 *
 * Creates a new agent (optional), configures model tiers,
 * and writes workspace files (AGENTS.md, HEARTBEAT.md, roles, memory).
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../types.js";
import { runSetup } from "../setup.js";
import { ALL_TIERS, DEFAULT_MODELS, type Tier } from "../tiers.js";

export function createSetupTool(api: OpenClawPluginApi) {
  return (ctx: ToolContext) => ({
    name: "devclaw_setup",
    label: "DevClaw Setup",
    description: `Execute DevClaw setup with collected configuration. Creates AGENTS.md, HEARTBEAT.md, role templates, memory/projects.json, and writes model tier config to openclaw.json. Optionally creates a new agent with channel binding and migration support. Backs up existing files before overwriting. This tool is typically called AFTER devclaw_onboard guides the conversation, but can be called directly if the user provides explicit configuration parameters.`,
    parameters: {
      type: "object",
      properties: {
        newAgentName: {
          type: "string",
          description: "Create a new agent with this name. If omitted, configures the current agent's workspace.",
        },
        channelBinding: {
          type: "string",
          enum: ["telegram", "whatsapp"],
          description: "Channel to bind the new agent to (optional). Only used when newAgentName is specified. If omitted, no binding is created.",
        },
        migrateFrom: {
          type: "string",
          description: "Agent ID to migrate channel binding from (optional). Use when replacing an existing agent's channel-wide binding. Call analyze_channel_bindings first to detect conflicts.",
        },
        models: {
          type: "object",
          description: `Model overrides per tier. Missing tiers use defaults. Example: { "junior": "anthropic/claude-haiku-4-5", "senior": "anthropic/claude-opus-4-5" }`,
          properties: {
            junior: { type: "string", description: `Junior dev model (default: ${DEFAULT_MODELS.junior})` },
            medior: { type: "string", description: `Medior dev model (default: ${DEFAULT_MODELS.medior})` },
            senior: { type: "string", description: `Senior dev model (default: ${DEFAULT_MODELS.senior})` },
            qa: { type: "string", description: `QA engineer model (default: ${DEFAULT_MODELS.qa})` },
          },
        },
        projectExecution: {
          type: "string",
          enum: ["parallel", "sequential"],
          description: "Plugin-level project execution mode: parallel (each project independent) or sequential (work on one project at a time). Default: parallel.",
        },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const newAgentName = params.newAgentName as string | undefined;
      const channelBinding = params.channelBinding as "telegram" | "whatsapp" | undefined;
      const migrateFrom = params.migrateFrom as string | undefined;
      const modelsParam = params.models as Partial<Record<Tier, string>> | undefined;
      const projectExecution = params.projectExecution as "parallel" | "sequential" | undefined;
      const workspaceDir = ctx.workspaceDir;

      const result = await runSetup({
        newAgentName,
        channelBinding: channelBinding ?? null,
        migrateFrom,
        // If no new agent name, use the current agent's workspace
        agentId: newAgentName ? undefined : ctx.agentId,
        workspacePath: newAgentName ? undefined : workspaceDir,
        models: modelsParam,
        projectExecution,
      });

      const lines = [
        result.agentCreated
          ? `Agent "${result.agentId}" created`
          : `Configured workspace for agent "${result.agentId}"`,
        ``,
      ];

      if (result.bindingMigrated) {
        lines.push(
          `✅ Channel binding migrated:`,
          `  ${result.bindingMigrated.channel} (from "${result.bindingMigrated.from}" → "${result.agentId}")`,
          ``,
        );
      }

      lines.push(
        `Models:`,
        ...ALL_TIERS.map((t) => `  ${t}: ${result.models[t]}`),
        ``,
        `Files written:`,
        ...result.filesWritten.map((f) => `  ${f}`),
      );

      if (result.warnings.length > 0) {
        lines.push(``, `Warnings:`, ...result.warnings.map((w) => `  ${w}`));
      }

      lines.push(
        ``,
        `Next steps:`,
        `  1. Add bot to a Telegram/WhatsApp group`,
        `  2. Register a project: "Register project <name> at <repo> for group <id>"`,
        `  3. Create your first issue and pick it up`,
      );

      return jsonResult({
        success: true,
        ...result,
        summary: lines.join("\n"),
      });
    },
  });
}
