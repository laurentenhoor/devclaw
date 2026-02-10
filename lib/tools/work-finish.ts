/**
 * work_finish — Complete a task (DEV done, QA pass/fail/refine/blocked).
 *
 * Delegates side-effects to pipeline service, then handles notifications,
 * audit, and optional auto-chain dispatch.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../types.js";
import type { StateLabel } from "../providers/provider.js";
import { createProvider } from "../providers/index.js";
import { resolveRepoPath, readProjects, getProject, getWorker, getSessionForModel } from "../projects.js";
import { executeCompletion, getRule, NEXT_STATE } from "../services/pipeline.js";
import { dispatchTask } from "../dispatch.js";
import { log as auditLog } from "../audit.js";
import { notify, getNotificationConfig } from "../notify.js";

export function createWorkFinishTool(api: OpenClawPluginApi) {
  return (ctx: ToolContext) => ({
    name: "work_finish",
    label: "Work Finish",
    description: `Complete a task: DEV done/blocked, QA pass/fail/refine/blocked. Handles label transition, state update, issue close/reopen, notifications, and audit. With auto-scheduling, dispatches the next step automatically.`,
    parameters: {
      type: "object",
      required: ["role", "result", "projectGroupId"],
      properties: {
        role: { type: "string", enum: ["dev", "qa"], description: "Worker role" },
        result: { type: "string", enum: ["done", "pass", "fail", "refine", "blocked"], description: "Completion result" },
        projectGroupId: { type: "string", description: "Project group ID" },
        summary: { type: "string", description: "Brief summary" },
        prUrl: { type: "string", description: "PR/MR URL (auto-detected if omitted)" },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const role = params.role as "dev" | "qa";
      const result = params.result as string;
      const groupId = params.projectGroupId as string;
      const summary = params.summary as string | undefined;
      const prUrl = params.prUrl as string | undefined;
      const workspaceDir = ctx.workspaceDir;

      if (!workspaceDir) throw new Error("No workspace directory available");

      // Validate role:result
      if (role === "dev" && result !== "done" && result !== "blocked")
        throw new Error(`DEV can only complete with "done" or "blocked", got "${result}"`);
      if (role === "qa" && result === "done")
        throw new Error(`QA cannot use "done". Use "pass", "fail", "refine", or "blocked".`);
      if (!getRule(role, result))
        throw new Error(`Invalid completion: ${role}:${result}`);

      // Resolve project + worker
      const data = await readProjects(workspaceDir);
      const project = getProject(data, groupId);
      if (!project) throw new Error(`Project not found for groupId: ${groupId}`);

      const worker = getWorker(project, role);
      if (!worker.active) throw new Error(`${role.toUpperCase()} worker not active on ${project.name}`);

      const issueId = worker.issueId ? Number(worker.issueId.split(",")[0]) : null;
      if (!issueId) throw new Error(`No issueId for active ${role.toUpperCase()} on ${project.name}`);

      const { provider } = createProvider({ repo: project.repo });
      const repoPath = resolveRepoPath(project.repo);

      // Execute completion (pipeline service)
      const completion = await executeCompletion({
        workspaceDir, groupId, role, result, issueId, summary, prUrl, provider, repoPath,
      });

      const output: Record<string, unknown> = {
        success: true, project: project.name, groupId, issueId, role, result,
        ...completion,
      };

      // Auto-chain dispatch
      const pluginConfig = api.pluginConfig as Record<string, unknown> | undefined;
      const scheduling = (pluginConfig?.scheduling as string) ?? "auto";

      if (scheduling === "auto") {
        const chainRole = result === "done" ? "qa" : result === "fail" ? "dev" : null;
        if (chainRole) {
          const chainModel = chainRole === "qa" ? "qa" : (getWorker(project, "dev").model ?? "medior");
          try {
            const issue = await provider.getIssue(issueId);
            const chainResult = await dispatchTask({
              workspaceDir, agentId: ctx.agentId, groupId, project, issueId,
              issueTitle: issue.title, issueDescription: issue.description ?? "", issueUrl: issue.web_url,
              role: chainRole, modelAlias: chainModel,
              fromLabel: result === "done" ? "To Test" : "To Improve",
              toLabel: chainRole === "qa" ? "Testing" : "Doing",
              transitionLabel: (id, from, to) => provider.transitionLabel(id, from as StateLabel, to as StateLabel),
              pluginConfig, sessionKey: ctx.sessionKey,
            });
            output.autoChain = { dispatched: true, role: chainRole, model: chainResult.modelAlias, announcement: chainResult.announcement };
          } catch (err) {
            output.autoChain = { dispatched: false, error: (err as Error).message };
          }
        }
      }

      // Notify
      const notifyConfig = getNotificationConfig(pluginConfig);
      await notify(
        { type: "workerComplete", project: project.name, groupId, issueId, role, result: result as "done" | "pass" | "fail" | "refine" | "blocked", summary, nextState: NEXT_STATE[`${role}:${result}`] },
        { workspaceDir, config: notifyConfig, groupId, channel: project.channel ?? "telegram" },
      );

      // Audit
      await auditLog(workspaceDir, "work_finish", {
        project: project.name, groupId, issue: issueId, role, result,
        summary: summary ?? null, labelTransition: completion.labelTransition,
        autoChain: output.autoChain ?? null,
      });

      return jsonResult(output);
    },
  });
}
