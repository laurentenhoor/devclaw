/**
 * queue_status — Show task queue and worker status across projects.
 *
 * Replaces manual GitLab scanning in HEARTBEAT.md.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../types.js";
import { readProjects, getProject } from "../projects.js";
import { type StateLabel } from "../issue-provider.js";
import { createProvider } from "../providers/index.js";
import { log as auditLog } from "../audit.js";
import { detectContext, generateGuardrails } from "../context-guard.js";

export function createQueueStatusTool(api: OpenClawPluginApi) {
  return (ctx: ToolContext) => ({
    name: "queue_status",
    label: "Queue Status",
    description: `Show task queue and worker status. Context-aware: In group chats, auto-filters to that project. In direct messages, shows all projects. Best for status checks, not during setup.`,
    parameters: {
      type: "object",
      properties: {
        projectGroupId: {
          type: "string",
          description: "Specific project group ID to check. Omit to check all projects.",
        },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const workspaceDir = ctx.workspaceDir;

      if (!workspaceDir) {
        throw new Error("No workspace directory available in tool context");
      }

      // --- Context detection ---
      const devClawAgentIds =
        ((api.pluginConfig as Record<string, unknown>)?.devClawAgentIds as
          | string[]
          | undefined) ?? [];
      const context = await detectContext(ctx, devClawAgentIds);

      // If via another agent (setup mode), suggest devclaw_onboard instead
      if (context.type === "via-agent") {
        return jsonResult({
          success: false,
          warning: "queue_status is for operational use, not setup.",
          recommendation: "If you're setting up DevClaw, use devclaw_onboard instead.",
          contextGuidance: generateGuardrails(context),
        });
      }

      // Auto-filter to current project in group context
      let groupId = params.projectGroupId as string | undefined;
      if (context.type === "group" && !groupId) {
        groupId = context.groupId; // Use the actual group ID for lookup
      }

      const data = await readProjects(workspaceDir);
      const projectIds = groupId
        ? [groupId]
        : Object.keys(data.projects);

      const projects: Array<Record<string, unknown>> = [];

      for (const pid of projectIds) {
        const project = getProject(data, pid);
        if (!project) continue;

        const { provider } = createProvider({
          repo: project.repo,
        });

        // Fetch queue counts from issue tracker
        const queueLabels: StateLabel[] = ["To Improve", "To Test", "To Do"];
        const queue: Record<string, Array<{ id: number; title: string }>> = {};

        for (const label of queueLabels) {
          try {
            const issues = await provider.listIssuesByLabel(label);
            queue[label] = issues.map((i) => ({ id: i.iid, title: i.title }));
          } catch {
            queue[label] = [];
          }
        }

        projects.push({
          name: project.name,
          groupId: pid,
          dev: {
            active: project.dev.active,
            issueId: project.dev.issueId,
            model: project.dev.model,
            sessions: project.dev.sessions,
          },
          qa: {
            active: project.qa.active,
            issueId: project.qa.issueId,
            model: project.qa.model,
            sessions: project.qa.sessions,
          },
          queue: {
            toImprove: queue["To Improve"],
            toTest: queue["To Test"],
            toDo: queue["To Do"],
          },
        });
      }

      // Audit log
      await auditLog(workspaceDir, "queue_status", {
        projectCount: projects.length,
        totalToImprove: projects.reduce(
          (sum, p) => sum + ((p.queue as Record<string, unknown[]>).toImprove?.length ?? 0),
          0,
        ),
        totalToTest: projects.reduce(
          (sum, p) => sum + ((p.queue as Record<string, unknown[]>).toTest?.length ?? 0),
          0,
        ),
        totalToDo: projects.reduce(
          (sum, p) => sum + ((p.queue as Record<string, unknown[]>).toDo?.length ?? 0),
          0,
        ),
      });

      return jsonResult({
        projects,
        context: {
          type: context.type,
          ...(context.type === "group" && {
            projectName: context.projectName,
            autoFiltered: !params.projectGroupId,
          }),
        },
        contextGuidance: generateGuardrails(context),
      });
    },
  });
}
