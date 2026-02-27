/**
 * channel_list — List channels for a project or all projects.
 *
 * Shows registered channels with their type, ID, name, and event subscriptions.
 * Can list channels for a specific project or all projects.
 */
import { jsonResult } from "openclaw/plugin-sdk";
import type { PluginContext } from "../../context.js";
import type { ToolContext } from "../../types.js";
import { readProjects } from "../../projects/index.js";
import { requireWorkspaceDir } from "../helpers.js";

export function createChannelListTool(_ctx: PluginContext) {
  return (toolCtx: ToolContext) => ({
    name: "channel_list",
    label: "Channel List",
    description:
      "List channels for a project or all projects. Shows channel type, ID, name, and event subscriptions.",
    parameters: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description:
            "Project name or slug to list channels for. Omit to list channels for all projects.",
        },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const projectRef = params.project as string | undefined;
      const workspaceDir = requireWorkspaceDir(toolCtx);

      const data = await readProjects(workspaceDir);

      if (projectRef) {
        // List channels for a specific project
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

        const channels = target.channels.map((ch) => ({
          channelId: ch.channelId,
          type: ch.channel,
          name: ch.name,
          events: ch.events,
          accountId: ch.accountId,
        }));

        const announcement =
          `**Channels for project "${target.name}"** (${channels.length}):\n\n` +
          (channels.length === 0
            ? "_(none)_"
            : channels
                .map(
                  (ch) =>
                    `• **${ch.name}** (${ch.type})\n  ID: \`${ch.channelId}\`\n  Events: ${ch.events.join(", ")}${
                      ch.accountId ? `\n  Account: ${ch.accountId}` : ""
                    }`,
                )
                .join("\n\n"));

        return jsonResult({
          success: true,
          project: target.name,
          projectSlug: target.slug,
          channels,
          announcement,
        });
      } else {
        // List channels for all projects
        const projects = Object.values(data.projects);

        if (projects.length === 0) {
          return jsonResult({
            success: true,
            projects: [],
            announcement: "No projects registered.",
          });
        }

        const projectChannels = projects.map((p) => ({
          project: p.name,
          projectSlug: p.slug,
          channels: p.channels.map((ch) => ({
            channelId: ch.channelId,
            type: ch.channel,
            name: ch.name,
            events: ch.events,
            accountId: ch.accountId,
          })),
        }));

        const announcement =
          "**Channels by project:**\n\n" +
          projectChannels
            .map((p) => {
              const channelList =
                p.channels.length === 0
                  ? "  _(no channels)_"
                  : p.channels
                      .map(
                        (ch) =>
                          `  • **${ch.name}** (${ch.type}) — \`${ch.channelId}\``,
                      )
                      .join("\n");
              return `**${p.project}** (${p.projectSlug}):\n${channelList}`;
            })
            .join("\n\n");

        return jsonResult({
          success: true,
          projects: projectChannels,
          announcement,
        });
      }
    },
  });
}
