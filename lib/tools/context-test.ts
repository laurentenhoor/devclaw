/**
 * context_test — Debug tool to test context detection.
 *
 * Call this from different contexts (DM, group, via another agent) to see
 * what context is detected and what guardrails are generated.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../types.js";
import { detectContext, generateGuardrails } from "../context-guard.js";

export function createContextTestTool(api: OpenClawPluginApi) {
  return (ctx: ToolContext) => ({
    name: "context_test",
    label: "Context Test (Debug)",
    description:
      "Debug tool: Shows detected context and guardrails. Use this to verify context detection works correctly in different scenarios (DM, group, via another agent).",
    parameters: {
      type: "object",
      properties: {},
    },

    async execute(_id: string, _params: Record<string, unknown>) {
      const devClawAgentIds =
        ((api.pluginConfig as Record<string, unknown>)?.devClawAgentIds as
          | string[]
          | undefined) ?? [];

      const context = await detectContext(ctx, devClawAgentIds);
      const guardrails = generateGuardrails(context);

      return jsonResult({
        success: true,
        debug: {
          toolContext: {
            agentId: ctx.agentId,
            messageChannel: ctx.messageChannel,
            sessionKey: ctx.sessionKey,
            workspaceDir: ctx.workspaceDir,
            agentAccountId: ctx.agentAccountId,
            sandboxed: ctx.sandboxed,
          },
          devClawAgentIds,
        },
        detectedContext: context,
        guardrails,
      });
    },
  });
}
