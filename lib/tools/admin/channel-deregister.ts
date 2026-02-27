/**
 * channel_deregister — Remove a channel from a project.
 *
 * Deregisters (unlinks) a channel from a project. Validates that the channel
 * exists and prevents removing the last channel from a project (projects must
 * have at least one notification endpoint).
 */
import { jsonResult } from "openclaw/plugin-sdk";
import type { PluginContext } from "../../context.js";
import type { ToolContext } from "../../types.js";
import { readProjects, writeProjects } from "../../projects/index.js";
import { log as auditLog } from "../../audit.js";
import { requireWorkspaceDir } from "../helpers.js";

export function createChannelDeregisterTool(_ctx: PluginContext) {
  return (toolCtx: ToolContext) => ({
    name: "channel_deregister",
    label: "Channel Deregister",
    description:
      "Remove a channel from a project. Validates that the channel exists and prevents " +
      "removing the last channel (projects must have at least one notification endpoint).",
    parameters: {
      type: "object",
      required: ["channelId", "project"],
      properties: {
        channelId: {
          type: "string",
          description: "Channel ID to remove (e.g., Telegram group ID)",
        },
        project: {
          type: "string",
          description: "Project name or slug to deregister the channel from",
        },
        confirm: {
          type: "boolean",
          description: "Set to true to confirm the removal. Defaults to false (dry-run).",
        },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const channelId = params.channelId as string;
      const projectRef = params.project as string;
      const confirm = params.confirm as boolean | undefined;
      const workspaceDir = requireWorkspaceDir(toolCtx);

      if (!channelId) throw new Error("channelId is required.");
      if (!projectRef) throw new Error("project is required.");

      const data = await readProjects(workspaceDir);

      // Resolve target project by slug or name
      const slug = projectRef.toLowerCase().replace(/\s+/g, "-");
      const target =
        data.projects[slug] ??
        Object.values(data.projects).find(
          (p) => p.name.toLowerCase() === projectRef.toLowerCase(),
        );

      if (!target) {
        const available = Object.values(data.projects)
          .map((p) => p.name)
          .join(", ");
        throw new Error(
          `Project "${projectRef}" not found. Available projects: ${available || "none"}.`,
        );
      }

      // Find the channel
      const idx = target.channels.findIndex((ch) => ch.channelId === channelId);
      if (idx === -1) {
        throw new Error(
          `Channel ${channelId} not found in project "${target.name}".`,
        );
      }

      // Prevent removing the last channel
      if (target.channels.length === 1) {
        throw new Error(
          `Cannot remove the last channel from project "${target.name}". Projects must have at least one channel.`,
        );
      }

      const channel = target.channels[idx];

      // Dry-run mode: show what would be removed
      if (!confirm) {
        return jsonResult({
          success: false,
          dryRun: true,
          project: target.name,
          projectSlug: target.slug,
          channelId,
          channelName: channel.name,
          channelType: channel.channel,
          remainingChannels: target.channels.length - 1,
          announcement:
            `DRY-RUN: Would remove channel "${channel.name}" (${channelId}) from project "${target.name}". ` +
            `${target.channels.length - 1} channel(s) would remain. Set confirm=true to proceed.`,
        });
      }

      // Remove the channel
      target.channels.splice(idx, 1);

      await writeProjects(workspaceDir, data);

      await auditLog(workspaceDir, "channel_deregister", {
        project: target.name,
        projectSlug: target.slug,
        channelId,
        channelName: channel.name,
        channelType: channel.channel,
      });

      return jsonResult({
        success: true,
        project: target.name,
        projectSlug: target.slug,
        channelId,
        channelName: channel.name,
        channelType: channel.channel,
        remainingChannels: target.channels.length,
        announcement:
          `Channel "${channel.name}" (${channelId}) deregistered from project "${target.name}". ` +
          `${target.channels.length} channel(s) remaining.`,
      });
    },
  });
}
