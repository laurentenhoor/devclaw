/**
 * queue_status — Show task queue and worker status across projects.
 *
 * Replaces manual GitLab scanning in HEARTBEAT.md.
 */
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk";
import { readProjects, getProject } from "../projects.js";
import { listIssuesByLabel, resolveRepoPath, type StateLabel } from "../gitlab.js";
import { log as auditLog } from "../audit.js";

export function createQueueStatusTool(api: OpenClawPluginApi) {
  return (ctx: OpenClawPluginToolContext) => ({
    name: "queue_status",
    description: `Show task queue counts and worker status for all projects (or a specific project). Returns To Improve, To Test, To Do issue counts and active DEV/QA session state.`,
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
      const groupId = params.projectGroupId as string | undefined;
      const workspaceDir = ctx.workspaceDir;

      if (!workspaceDir) {
        throw new Error("No workspace directory available in tool context");
      }

      const data = await readProjects(workspaceDir);
      const projectIds = groupId
        ? [groupId]
        : Object.keys(data.projects);

      const glabPath = (api.pluginConfig as Record<string, unknown>)?.glabPath as string | undefined;
      const projects: Array<Record<string, unknown>> = [];

      for (const pid of projectIds) {
        const project = getProject(data, pid);
        if (!project) continue;

        const repoPath = resolveRepoPath(project.repo);
        const glabOpts = { glabPath, repoPath };

        // Fetch queue counts from GitLab
        const queueLabels: StateLabel[] = ["To Improve", "To Test", "To Do"];
        const queue: Record<string, Array<{ id: number; title: string }>> = {};

        for (const label of queueLabels) {
          try {
            const issues = await listIssuesByLabel(label, glabOpts);
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

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ projects }, null, 2),
          },
        ],
      };
    },
  });
}
