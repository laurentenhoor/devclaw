/**
 * status — Lightweight queue + worker state dashboard.
 *
 * Shows worker state and queue counts per project. No health checks
 * (use `health` tool), no complex sequencing.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../types.js";
import { readProjects, getProject } from "../projects.js";
import { log as auditLog } from "../audit.js";
import { fetchProjectQueues, type QueueLabel } from "../services/queue.js";
import { requireWorkspaceDir, getPluginConfig } from "../tool-helpers.js";

export function createStatusTool(api: OpenClawPluginApi) {
  return (ctx: ToolContext) => ({
    name: "status",
    label: "Status",
    description: `Show task queue and worker state per project. Use \`health\` tool for worker health checks.`,
    parameters: {
      type: "object",
      properties: {
        projectGroupId: { type: "string", description: "Filter to specific project. Omit for all." },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const workspaceDir = requireWorkspaceDir(ctx);
      const groupId = params.projectGroupId as string | undefined;

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
      });
    },
  });
}
