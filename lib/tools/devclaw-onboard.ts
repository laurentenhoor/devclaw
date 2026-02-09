/**
 * devclaw_onboard — Explicit tool for triggering DevClaw onboarding.
 *
 * Provides discoverable, tool-based onboarding that doesn't rely on
 * keyword detection. Returns conversational context as a tool result.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../types.js";
import {
  isPluginConfigured,
  hasWorkspaceFiles,
  buildOnboardToolContext,
  buildReconfigContext,
} from "../onboarding.js";
import { detectContext, generateGuardrails } from "../context-guard.js";

export function createOnboardTool(api: OpenClawPluginApi) {
  return (ctx: ToolContext) => ({
    name: "devclaw_onboard",
    label: "DevClaw Onboarding",
    description:
      "Start DevClaw onboarding workflow. Use this tool when the user wants to: set up DevClaw, install DevClaw, onboard DevClaw, configure DevClaw, get started with DevClaw, or asks questions like 'can we install devclaw?', 'how do I set up devclaw?', 'let's onboard devclaw'. Returns step-by-step QA-style guidance. Call this FIRST before calling devclaw_setup to provide conversational setup experience.",
    parameters: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["first-run", "reconfigure"],
          description:
            "Whether this is first-time setup (first-run) or reconfiguration (reconfigure). Auto-detected if omitted.",
        },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      // --- Context detection ---
      const devClawAgentIds =
        ((api.pluginConfig as Record<string, unknown>)?.devClawAgentIds as
          | string[]
          | undefined) ?? [];
      const context = await detectContext(ctx, devClawAgentIds);

      // Warn if called in wrong context (group chat)
      if (context.type === "group") {
        return jsonResult({
          success: false,
          error: "DevClaw onboarding should not be done in project group chats.",
          recommendation:
            "Please discuss DevClaw setup in a direct message with the DevClaw agent or via another agent (like your main assistant).",
          contextGuidance: generateGuardrails(context),
        });
      }

      const configured = isPluginConfigured(
        api.pluginConfig as Record<string, unknown>,
      );
      const hasWorkspace = await hasWorkspaceFiles(ctx.workspaceDir);

      const mode = params.mode
        ? (params.mode as "first-run" | "reconfigure")
        : configured && hasWorkspace
          ? "reconfigure"
          : "first-run";

      const instructions =
        mode === "first-run"
          ? buildOnboardToolContext()
          : buildReconfigContext(api.pluginConfig as Record<string, unknown>);

      return jsonResult({
        success: true,
        mode,
        configured,
        instructions,
        contextGuidance: generateGuardrails(context),
        nextSteps: [
          "Follow the instructions above",
          "Call devclaw_setup with your collected answers",
          mode === "first-run" ? "Optional: register a project afterward" : null,
        ].filter(Boolean),
      });
    },
  });
}
