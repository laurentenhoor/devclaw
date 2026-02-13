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
import { fetchProjectQueues, getTotalQueuedCount, getQueueLabelsWithPriority } from "../services/queue.js";
import { requireWorkspaceDir, getPluginConfig } from "../tool-helpers.js";
import { DEFAULT_WORKFLOW } from "../workflow.js";

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

      // TODO: Load per-project workflow when supported
      const workflow = DEFAULT_WORKFLOW;

      const data = await readProjects(workspaceDir);
      const projectIds = groupId ? [groupId] : Object.keys(data.projects);

      // Build project summaries with queue counts
      const projects = await Promise.all(
        projectIds.map(async (pid) => {
          const project = getProject(data, pid);
          if (!project) return null;

          const queues = await fetchProjectQueues(project, workflow);

          // Build dynamic queue object with counts
          const queueCounts: Record<string, number> = {};
          for (const [label, issues] of Object.entries(queues)) {
            queueCounts[label] = issues.length;
          }

          return {
            name: project.name,
            groupId: pid,
            roleExecution: project.roleExecution ?? "parallel",
            dev: {
              active: project.dev.active,
              issueId: project.dev.issueId,
              level: project.dev.level,
              startTime: project.dev.startTime,
            },
            qa: {
              active: project.qa.active,
              issueId: project.qa.issueId,
              level: project.qa.level,
              startTime: project.qa.startTime,
            },
            queue: queueCounts,
          };
        }),
      );

      const filtered = projects.filter(Boolean) as NonNullable<typeof projects[number]>[];

      // Calculate total queued across all projects
      const totalQueued = filtered.reduce(
        (sum, p) => sum + Object.values(p.queue).reduce((s, c) => s + c, 0),
        0,
      );

      await auditLog(workspaceDir, "status", {
        projectCount: filtered.length,
        totalQueued,
      });

      // Include queue labels in response for context
      const queueLabels = getQueueLabelsWithPriority(workflow).map((q) => ({
        label: q.label,
        role: q.role,
        priority: q.priority,
      }));

      return jsonResult({
        success: true,
        execution: { projectExecution },
        queueLabels,
        projects: filtered,
      });
    },
  });
}
