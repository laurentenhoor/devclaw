/**
 * status — Lightweight queue + worker state dashboard.
 *
 * Shows worker state and queue counts per project. No health checks
 * (use `health` tool), no complex sequencing.
 * Context-aware: auto-filters to project in group chats.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../types.js";
import { readProjects, getProject } from "../projects.js";
import { generateGuardrails } from "../context-guard.js";
import { log as auditLog } from "../audit.js";
import { fetchProjectQueues, type QueueLabel } from "../services/queue.js";
import { requireWorkspaceDir, resolveContext, getPluginConfig } from "../tool-helpers.js";

export function createStatusTool(api: OpenClawPluginApi) {
  return (ctx: ToolContext) => ({
    name: "status",
    label: "Status",
    description: `Show task queue and worker state per project. Context-aware: auto-filters in group chats. Use \`health\` tool for worker health checks.`,
    parameters: {
      type: "object",
      properties: {
        projectGroupId: { type: "string", description: "Filter to specific project. Omit for all." },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const workspaceDir = requireWorkspaceDir(ctx);

      const context = await resolveContext(ctx, api);
      if (context.type === "via-agent") {
        return jsonResult({
          success: false,
          warning: "status is for operational use, not setup.",
          recommendation: "Use onboard instead for DevClaw setup.",
          contextGuidance: generateGuardrails(context),
        });
      }

      // Auto-filter in group context
      let groupId = params.projectGroupId as string | undefined;
      if (context.type === "group" && !groupId) groupId = context.groupId;

      const pluginConfig = getPluginConfig(api);
      const projectExecution = (pluginConfig?.projectExecution as string) ?? "parallel";

      const data = await readProjects(workspaceDir);
      const projectIds = groupId ? [groupId] : Object.keys(data.projects);

      // Build project summaries with queue counts
      const projects = await Promise.all(
        projectIds.map(async (pid) => {
          const project = getProject(data, pid);
          if (!project) return null;

          const queues = await fetchProjectQueues(project);
          const count = (label: QueueLabel) => queues[label].length;

          return {
            name: project.name,
            groupId: pid,
            roleExecution: project.roleExecution ?? "parallel",
            dev: { active: project.dev.active, issueId: project.dev.issueId, level: project.dev.level, startTime: project.dev.startTime },
            qa: { active: project.qa.active, issueId: project.qa.issueId, level: project.qa.level, startTime: project.qa.startTime },
            queue: { toImprove: count("To Improve"), toTest: count("To Test"), toDo: count("To Do") },
          };
        }),
      );

      const filtered = projects.filter(Boolean);

      await auditLog(workspaceDir, "status", {
        projectCount: filtered.length,
        totalQueued: filtered.reduce((s, p) => s + p!.queue.toImprove + p!.queue.toTest + p!.queue.toDo, 0),
      });

      return jsonResult({
        success: true,
        execution: { projectExecution },
        projects: filtered,
        context: {
          type: context.type,
          ...(context.type === "group" && { projectName: context.projectName, autoFiltered: !params.projectGroupId }),
        },
        contextGuidance: generateGuardrails(context),
      });
    },
  });
}
