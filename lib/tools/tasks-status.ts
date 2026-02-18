/**
 * tasks_status — Full dashboard: hold (waiting for input), active (working), queued (pending).
 *
 * Shows all non-terminal state types with issue details.
 * No health checks (use `health` tool).
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../types.js";
import { readProjects, getProject } from "../projects.js";
import { log as auditLog } from "../audit.js";
import { getStateLabelsByType } from "../services/queue.js";
import { requireWorkspaceDir, getPluginConfig } from "../tool-helpers.js";
import { createProvider } from "../providers/index.js";
import { loadWorkflow, ExecutionMode, StateType } from "../workflow.js";

type IssueSummary = { id: number; title: string; url: string };

export function createTasksStatusTool(api: OpenClawPluginApi) {
  return (ctx: ToolContext) => ({
    name: "tasks_status",
    label: "Tasks Status",
    description: `Show full project dashboard: issues waiting for input (hold), work in progress (active), and queued for work (queue) — all with issue details. Use \`health\` for worker health checks, \`task_list\` to filter/search issues.`,
    parameters: {
      type: "object",
      properties: {
        projectSlug: { type: "string", description: "Project slug. Omit for all." },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const workspaceDir = requireWorkspaceDir(ctx);
      const slugOrGroupId = (params.projectSlug ?? params.projectGroupId) as string | undefined;

      const pluginConfig = getPluginConfig(api);
      const projectExecution = (pluginConfig?.projectExecution as string) ?? ExecutionMode.PARALLEL;

      const workflow = await loadWorkflow(workspaceDir);
      const statesByType = getStateLabelsByType(workflow);

      const data = await readProjects(workspaceDir);

      // Resolve slug filter
      let slugs = Object.keys(data.projects);
      if (slugOrGroupId) {
        const slug = getProject(data, slugOrGroupId) ?
          (data.projects[slugOrGroupId] ? slugOrGroupId :
            Object.keys(data.projects).find(s => data.projects[s].channels.some(ch => ch.groupId === slugOrGroupId)))
          : undefined;
        slugs = slug ? [slug] : [];
      }

      // Build project summaries
      const projects = await Promise.all(
        slugs.map(async (slug) => {
          const project = data.projects[slug];
          if (!project) return null;

          const { provider } = await createProvider({ repo: project.repo, provider: project.provider });

          // Fetch issues for each state type
          const hold: Record<string, { count: number; issues: IssueSummary[] }> = {};
          for (const { label } of statesByType.hold) {
            const issues = await provider.listIssues({ label, state: "open" }).catch(() => []);
            hold[label] = {
              count: issues.length,
              issues: issues.map((i) => ({ id: i.iid, title: i.title, url: i.web_url })),
            };
          }

          const active: Record<string, { count: number; issues: IssueSummary[] }> = {};
          for (const { label } of statesByType.active) {
            const issues = await provider.listIssues({ label, state: "open" }).catch(() => []);
            active[label] = {
              count: issues.length,
              issues: issues.map((i) => ({ id: i.iid, title: i.title, url: i.web_url })),
            };
          }

          const queue: Record<string, { count: number; issues: IssueSummary[] }> = {};
          for (const { label } of statesByType.queue) {
            const issues = await provider.listIssues({ label, state: "open" }).catch(() => []);
            queue[label] = {
              count: issues.length,
              issues: issues.map((i) => ({ id: i.iid, title: i.title, url: i.web_url })),
            };
          }

          // Workers summary
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
            hold,
            active,
            queue,
          };
        }),
      );

      const filtered = projects.filter(Boolean) as NonNullable<typeof projects[number]>[];

      // Totals
      const totalHold = filtered.reduce(
        (sum, p) => sum + Object.values(p.hold).reduce((s, c) => s + c.count, 0), 0,
      );
      const totalActive = filtered.reduce(
        (sum, p) => sum + Object.values(p.active).reduce((s, c) => s + c.count, 0), 0,
      );
      const totalQueued = filtered.reduce(
        (sum, p) => sum + Object.values(p.queue).reduce((s, c) => s + c.count, 0), 0,
      );

      await auditLog(workspaceDir, "tasks_status", {
        projectCount: filtered.length,
        totalHold,
        totalActive,
        totalQueued,
      });

      // State labels for context
      const stateLabels = {
        hold: statesByType.hold.map((s) => ({ label: s.label, hint: "waiting for input" })),
        active: statesByType.active.map((s) => ({ label: s.label, role: s.role })),
        queue: statesByType.queue.map((s) => ({ label: s.label, role: s.role, priority: s.priority })),
      };

      // Active workflow summary
      const hasTestPhase = Object.values(workflow.states).some(
        (s) => s.role === "tester" && (s.type === StateType.QUEUE || s.type === StateType.ACTIVE),
      );
      const activeWorkflow = {
        reviewPolicy: workflow.reviewPolicy ?? "human",
        testPhase: hasTestPhase,
        stateFlow: Object.entries(workflow.states)
          .map(([, s]) => s.label)
          .join(" → "),
        hint: "To change the workflow, call workflow_guide first for the full reference.",
      };

      return jsonResult({
        success: true,
        execution: { projectExecution },
        activeWorkflow,
        stateLabels,
        summary: { totalHold, totalActive, totalQueued },
        projects: filtered,
      });
    },
  });
}
