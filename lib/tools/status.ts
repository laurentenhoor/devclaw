/**
 * status — Unified queue + health overview.
 *
 * Merges queue_status + session_health into a single tool.
 * Context-aware: auto-filters to project in group chats.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../types.js";
import { readProjects, getProject, type Project } from "../projects.js";
import { generateGuardrails } from "../context-guard.js";
import { log as auditLog } from "../audit.js";
import { checkWorkerHealth } from "../services/health.js";
import {
  fetchProjectQueues, buildParallelProjectSequences, buildGlobalTaskSequence,
  formatProjectQueues, type ProjectQueues, type ProjectExecutionConfig,
} from "../services/queue.js";
import { requireWorkspaceDir, resolveContext, resolveProvider, getPluginConfig } from "../tool-helpers.js";

export function createStatusTool(api: OpenClawPluginApi) {
  return (ctx: ToolContext) => ({
    name: "status",
    label: "Status",
    description: `Show task queue, worker status, and health across projects. Context-aware: auto-filters in group chats. Pass activeSessions for zombie detection.`,
    parameters: {
      type: "object",
      properties: {
        projectGroupId: { type: "string", description: "Filter to specific project. Omit for all." },
        includeHealth: { type: "boolean", description: "Run health checks. Default: true." },
        activeSessions: { type: "array", items: { type: "string" }, description: "Active session IDs for zombie detection." },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const workspaceDir = requireWorkspaceDir(ctx);
      const includeHealth = (params.includeHealth as boolean) ?? true;
      const activeSessions = (params.activeSessions as string[]) ?? [];

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
      const projectExecution = (pluginConfig?.projectExecution as "parallel" | "sequential") ?? "parallel";

      const data = await readProjects(workspaceDir);
      const projectIds = groupId ? [groupId] : Object.keys(data.projects);

      // Build execution configs + fetch queues
      const configs: ProjectExecutionConfig[] = [];
      const projectList: Array<{ id: string; project: Project }> = [];

      for (const pid of projectIds) {
        const project = getProject(data, pid);
        if (!project) continue;
        projectList.push({ id: pid, project });
        configs.push({
          name: project.name, groupId: pid,
          roleExecution: project.roleExecution ?? "parallel",
          devActive: project.dev.active, qaActive: project.qa.active,
          devIssueId: project.dev.issueId, qaIssueId: project.qa.issueId,
        });
      }

      // Health checks (read-only — never auto-fix from status)
      const healthIssues: Array<Record<string, unknown>> = [];
      if (includeHealth) {
        for (const { id, project } of projectList) {
          const { provider } = resolveProvider(project);
          for (const role of ["dev", "qa"] as const) {
            const fixes = await checkWorkerHealth({
              workspaceDir, groupId: id, project, role, activeSessions,
              autoFix: false, provider,
            });
            for (const f of fixes) healthIssues.push({ ...f.issue, fixed: f.fixed });
          }
        }
      }

      // Fetch queues
      const projectQueues: ProjectQueues[] = await Promise.all(
        projectList.map(async ({ id, project }) => ({
          projectId: id, project,
          queues: await fetchProjectQueues(project),
        })),
      );

      // Build sequences
      const sequences = projectExecution === "sequential"
        ? { mode: "sequential" as const, global: buildGlobalTaskSequence(projectQueues) }
        : { mode: "parallel" as const, projects: buildParallelProjectSequences(projectQueues) };

      // Build project details
      const projects = projectQueues.map(({ projectId, project, queues }) => ({
        name: project.name, groupId: projectId,
        dev: { active: project.dev.active, issueId: project.dev.issueId, tier: project.dev.tier, sessions: project.dev.sessions },
        qa: { active: project.qa.active, issueId: project.qa.issueId, tier: project.qa.tier, sessions: project.qa.sessions },
        queue: formatProjectQueues(queues),
      }));

      await auditLog(workspaceDir, "status", {
        projectCount: projects.length,
        totalToImprove: projects.reduce((s, p) => s + p.queue.toImprove.length, 0),
        totalToTest: projects.reduce((s, p) => s + p.queue.toTest.length, 0),
        totalToDo: projects.reduce((s, p) => s + p.queue.toDo.length, 0),
        healthIssues: healthIssues.length,
      });

      return jsonResult({
        execution: { plugin: { projectExecution }, projects: configs },
        sequences, projects,
        health: includeHealth ? { issues: healthIssues, note: activeSessions.length === 0 ? "No activeSessions — zombie detection skipped." : undefined } : undefined,
        context: {
          type: context.type,
          ...(context.type === "group" && { projectName: context.projectName, autoFiltered: !params.projectGroupId }),
        },
        contextGuidance: generateGuardrails(context),
      });
    },
  });
}
