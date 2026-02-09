/**
 * task_pickup — Atomically pick up a task from the issue queue.
 *
 * Handles: validation, model selection, then delegates to dispatchTask()
 * for label transition, session creation/reuse, task dispatch, state update,
 * and audit logging.
 *
 * Model selection is LLM-based: the orchestrator passes a `model` param.
 * A keyword heuristic is used as fallback if no model is specified.
 */
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk";
import { readProjects, getProject, getWorker } from "../projects.js";
import {
  getIssue,
  getCurrentStateLabel,
  transitionLabel,
  resolveRepoPath,
  type StateLabel,
} from "../gitlab.js";
import { selectModel } from "../model-selector.js";
import { dispatchTask } from "../dispatch.js";

export function createTaskPickupTool(api: OpenClawPluginApi) {
  return (ctx: OpenClawPluginToolContext) => ({
    name: "task_pickup",
    description: `Pick up a task from the issue queue for a DEV or QA worker. Handles everything end-to-end: label transition, model selection, session creation/reuse, task dispatch, state update, and audit logging. The orchestrator should analyze the issue and pass the appropriate model. Returns an announcement for the agent to post — no further session actions needed.`,
    parameters: {
      type: "object",
      required: ["issueId", "role", "projectGroupId"],
      properties: {
        issueId: { type: "number", description: "Issue ID to pick up" },
        role: { type: "string", enum: ["dev", "qa"], description: "Worker role: dev or qa" },
        projectGroupId: {
          type: "string",
          description: "Telegram group ID (key in projects.json). Required — pass the group ID from the current conversation.",
        },
        model: {
          type: "string",
          description: "Model alias to use (e.g. haiku, sonnet, opus, grok). The orchestrator should analyze the issue complexity and choose. Falls back to keyword heuristic if omitted.",
        },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const issueId = params.issueId as number;
      const role = params.role as "dev" | "qa";
      const groupId = params.projectGroupId as string;
      const modelParam = params.model as string | undefined;
      const workspaceDir = ctx.workspaceDir;

      if (!workspaceDir) {
        throw new Error("No workspace directory available in tool context");
      }

      // 1. Resolve project
      const data = await readProjects(workspaceDir);
      const project = getProject(data, groupId);
      if (!project) {
        throw new Error(
          `Project not found for groupId: ${groupId}. Available: ${Object.keys(data.projects).join(", ")}`,
        );
      }

      // 2. Check no active worker for this role
      const worker = getWorker(project, role);
      if (worker.active) {
        throw new Error(
          `${role.toUpperCase()} worker already active on ${project.name} (issue: ${worker.issueId}). Complete current task first.`,
        );
      }

      // 3. Fetch issue and verify state
      const repoPath = resolveRepoPath(project.repo);
      const glabOpts = {
        glabPath: (api.pluginConfig as Record<string, unknown>)?.glabPath as string | undefined,
        repoPath,
      };

      const issue = await getIssue(issueId, glabOpts);
      const currentLabel = getCurrentStateLabel(issue);

      const validLabelsForDev: StateLabel[] = ["To Do", "To Improve"];
      const validLabelsForQa: StateLabel[] = ["To Test"];
      const validLabels = role === "dev" ? validLabelsForDev : validLabelsForQa;

      if (!currentLabel || !validLabels.includes(currentLabel)) {
        throw new Error(
          `Issue #${issueId} has label "${currentLabel ?? "none"}" but expected one of: ${validLabels.join(", ")}. Cannot pick up for ${role.toUpperCase()}.`,
        );
      }

      // 4. Select model
      const targetLabel: StateLabel = role === "dev" ? "Doing" : "Testing";
      let modelAlias: string;
      let modelReason: string;
      let modelSource: string;

      if (modelParam) {
        modelAlias = modelParam;
        modelReason = "LLM-selected by orchestrator";
        modelSource = "llm";
      } else {
        const selected = selectModel(issue.title, issue.description ?? "", role);
        modelAlias = selected.alias;
        modelReason = selected.reason;
        modelSource = "heuristic";
      }

      // 5. Dispatch via shared logic
      const dispatchResult = await dispatchTask({
        workspaceDir,
        agentId: ctx.agentId,
        groupId,
        project,
        issueId,
        issueTitle: issue.title,
        issueDescription: issue.description ?? "",
        issueUrl: issue.web_url,
        role,
        modelAlias,
        fromLabel: currentLabel,
        toLabel: targetLabel,
        transitionLabel: (id, from, to) =>
          transitionLabel(id, from as StateLabel, to as StateLabel, glabOpts),
      });

      // 6. Build result
      const result: Record<string, unknown> = {
        success: true,
        project: project.name,
        groupId,
        issueId,
        issueTitle: issue.title,
        role,
        model: dispatchResult.modelAlias,
        fullModel: dispatchResult.fullModel,
        sessionAction: dispatchResult.sessionAction,
        announcement: dispatchResult.announcement,
        labelTransition: `${currentLabel} → ${targetLabel}`,
        modelReason,
        modelSource,
      };

      if (dispatchResult.sessionAction === "send") {
        result.tokensSavedEstimate = "~50K (session reuse)";
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  });
}
