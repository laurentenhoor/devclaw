/**
 * onboard — Conversational DevClaw onboarding.
 *
 * Returns step-by-step guidance. Call this before setup.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../types.js";
import { isPluginConfigured, hasWorkspaceFiles, buildOnboardToolContext, buildReconfigContext } from "../onboarding.js";

export function createOnboardTool(api: OpenClawPluginApi) {
  return (ctx: ToolContext) => ({
    name: "onboard",
    label: "Onboard",
    description: "Start DevClaw onboarding workflow. Returns step-by-step QA-style guidance. Call this first, then setup with collected answers.",
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["first-run", "reconfigure"], description: "Auto-detected if omitted." },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const configured = isPluginConfigured(api.pluginConfig as Record<string, unknown>);
      const hasWorkspace = await hasWorkspaceFiles(ctx.workspaceDir);
      const mode = params.mode ? (params.mode as "first-run" | "reconfigure")
        : configured && hasWorkspace ? "reconfigure" : "first-run";

      const instructions = mode === "first-run" ? buildOnboardToolContext() : buildReconfigContext();

      return jsonResult({
        success: true, mode, configured, instructions,
        nextSteps: ["Follow instructions above", "Call setup with collected answers", mode === "first-run" ? "Register a project afterward" : null].filter(Boolean),
      });
    },
  });
}
