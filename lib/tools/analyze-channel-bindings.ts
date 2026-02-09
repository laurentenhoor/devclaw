/**
 * analyze_channel_bindings — Check channel availability and detect binding conflicts.
 *
 * Returns analysis of the current channel binding state, including:
 * - Whether the channel is configured and enabled
 * - Existing channel-wide bindings (potential conflicts)
 * - Existing group-specific bindings (no conflicts)
 * - Recommendations for what to do
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../types.js";
import {
  analyzeChannelBindings,
  type ChannelType,
} from "../binding-manager.js";

export function createAnalyzeChannelBindingsTool(api: OpenClawPluginApi) {
  return (_ctx: ToolContext) => ({
    name: "analyze_channel_bindings",
    label: "Analyze Channel Bindings",
    description:
      "Check if a channel (telegram/whatsapp) is configured and analyze existing bindings. Use this during onboarding when the user selects a channel binding (telegram/whatsapp) to: detect if the channel is configured and enabled, identify existing channel-wide bindings that would conflict, and provide smart recommendations (migrate binding, skip binding, or proceed). Call this BEFORE devclaw_setup when creating a new agent with channel binding.",
    parameters: {
      type: "object",
      properties: {
        channel: {
          type: "string",
          enum: ["telegram", "whatsapp"],
          description: "The channel to analyze (telegram or whatsapp)",
        },
      },
      required: ["channel"],
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const channel = params.channel as ChannelType;

      const analysis = await analyzeChannelBindings(channel);

      const lines = [`**${channel.charAt(0).toUpperCase() + channel.slice(1)} Binding Analysis**`, ``];

      if (!analysis.channelConfigured) {
        lines.push(`❌ Channel not configured`);
      } else if (!analysis.channelEnabled) {
        lines.push(`⚠️ Channel configured but disabled`);
      } else {
        lines.push(`✅ Channel configured and enabled`);
      }

      lines.push(``);

      if (analysis.existingChannelWideBinding) {
        lines.push(
          `**Existing Channel-Wide Binding:**`,
          `  Agent: ${analysis.existingChannelWideBinding.agentName} (${analysis.existingChannelWideBinding.agentId})`,
          `  ⚠️ This agent receives ALL ${channel} messages`,
          ``,
        );
      }

      if (analysis.groupSpecificBindings.length > 0) {
        lines.push(
          `**Group-Specific Bindings:**`,
          ...analysis.groupSpecificBindings.map(
            (b) => `  • ${b.agentName} (${b.agentId}) → group ${b.groupId}`,
          ),
          ``,
        );
      }

      lines.push(`**Recommendation:**`, analysis.recommendation);

      return jsonResult({
        success: true,
        channel,
        ...analysis,
        summary: lines.join("\n"),
      });
    },
  });
}
