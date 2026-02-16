/**
 * work_finish — Complete a task (DEV done, QA pass/fail/refine/blocked).
 *
 * Delegates side-effects to pipeline service: label transition, state update,
 * issue close/reopen, notifications, and audit logging.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../types.js";
import { getWorker, resolveRepoPath } from "../projects.js";
import { executeCompletion, getRule } from "../services/pipeline.js";
import { log as auditLog } from "../audit.js";
import { requireWorkspaceDir, resolveProject, resolveProvider, getPluginConfig } from "../tool-helpers.js";
import { getAllRoleIds, isValidResult, getCompletionResults } from "../roles/index.js";
import { loadWorkflow } from "../workflow.js";

export function createWorkFinishTool(api: OpenClawPluginApi) {
  return (ctx: ToolContext) => ({
    name: "work_finish",
    label: "Work Finish",
    description: `Complete a task: Developer done (PR created, goes to review) or blocked. Tester pass/fail/refine/blocked. Reviewer approve/reject/blocked. Handles label transition, state update, issue close/reopen, notifications, and audit logging.`,
    parameters: {
      type: "object",
      required: ["role", "result", "projectGroupId"],
      properties: {
        role: { type: "string", enum: getAllRoleIds(), description: "Worker role" },
        result: { type: "string", enum: ["done", "pass", "fail", "refine", "blocked", "approve", "reject"], description: "Completion result" },
        projectGroupId: { type: "string", description: "Project group ID" },
        summary: { type: "string", description: "Brief summary" },
        prUrl: { type: "string", description: "PR/MR URL (auto-detected if omitted)" },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const role = params.role as string;
      const result = params.result as string;
      const groupId = params.projectGroupId as string;
      const summary = params.summary as string | undefined;
      const prUrl = params.prUrl as string | undefined;
      const workspaceDir = requireWorkspaceDir(ctx);

      // Validate role:result using registry
      if (!isValidResult(role, result)) {
        const valid = getCompletionResults(role);
        throw new Error(`${role.toUpperCase()} cannot complete with "${result}". Valid results: ${valid.join(", ")}`);
      }
      if (!getRule(role, result))
        throw new Error(`Invalid completion: ${role}:${result}`);

      // Resolve project + worker
      const { project } = await resolveProject(workspaceDir, groupId);
      const worker = getWorker(project, role);
      if (!worker.active) throw new Error(`${role.toUpperCase()} worker not active on ${project.name}`);

      const issueId = worker.issueId ? Number(worker.issueId.split(",")[0]) : null;
      if (!issueId) throw new Error(`No issueId for active ${role.toUpperCase()} on ${project.name}`);

      const { provider } = await resolveProvider(project);
      const repoPath = resolveRepoPath(project.repo);
      const issue = await provider.getIssue(issueId);

      const pluginConfig = getPluginConfig(api);
      const workflow = await loadWorkflow(workspaceDir, project.name);

      // Execute completion (pipeline service handles notification with runtime)
      const completion = await executeCompletion({
        workspaceDir, groupId, role, result, issueId, summary, prUrl, provider, repoPath,
        projectName: project.name,
        channel: project.channel,
        pluginConfig,
        runtime: api.runtime,
        workflow,
      });

      const output: Record<string, unknown> = {
        success: true, project: project.name, groupId, issueId, role, result,
        ...completion,
      };

      // Audit
      await auditLog(workspaceDir, "work_finish", {
        project: project.name, groupId, issue: issueId, role, result,
        summary: summary ?? null, labelTransition: completion.labelTransition,
      });

      return jsonResult(output);
    },
  });
}
