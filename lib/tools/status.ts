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
import { loadWorkflow, ExecutionMode } from "../workflow.js";

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
      const slugOrGroupId = params.projectGroupId as string | undefined;

      const pluginConfig = getPluginConfig(api);
      const projectExecution = (pluginConfig?.projectExecution as string) ?? ExecutionMode.PARALLEL;

      // Load workspace-level workflow (per-project loaded inside map)
      const workflow = await loadWorkflow(workspaceDir);

      const data = await readProjects(workspaceDir);
      
      // If filter provided, resolve to slug
      let slugs = Object.keys(data.projects);
      if (slugOrGroupId) {
        const slug = getProject(data, slugOrGroupId) ? 
          (data.projects[slugOrGroupId] ? slugOrGroupId : 
            Object.keys(data.projects).find(s => data.projects[s].channels.some(ch => ch.groupId === slugOrGroupId))) 
          : undefined;
        slugs = slug ? [slug] : [];
      }

      // Build project summaries with queue counts
      const projects = await Promise.all(
        slugs.map(async (slug) => {
          const project = data.projects[slug];
          if (!project) return null;

          const queues = await fetchProjectQueues(project, workflow);

          // Build dynamic queue object with counts
          const queueCounts: Record<string, number> = {};
          for (const [label, issues] of Object.entries(queues)) {
            queueCounts[label] = issues.length;
          }

          // Build dynamic workers summary
          const workers: Record<string, { active: boolean; issueId: string | null; level: string | null; startTime: string | null }> = {};
          for (const [role, worker] of Object.entries(project.workers)) {
            workers[role] = {
              active: worker.active,
              issueId: worker.issueId,
              level: worker.level,
              startTime: worker.startTime,
            };
          }

          return {
            name: project.name,
            slug,
            primaryGroupId: project.channels[0]?.groupId || slug,
            roleExecution: project.roleExecution ?? ExecutionMode.PARALLEL,
            workers,
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
