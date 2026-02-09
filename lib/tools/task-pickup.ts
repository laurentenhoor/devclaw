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
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import { dispatchTask } from "../dispatch.js";
import {
  getCurrentStateLabel,
  getIssue,
  resolveRepoPath,
  transitionLabel,
  type StateLabel,
} from "../gitlab.js";
import { selectModel } from "../model-selector.js";
import { getProject, getWorker, readProjects } from "../projects.js";
import type { ToolContext } from "../types.js";
import { detectContext, generateGuardrails } from "../context-guard.js";

export function createTaskPickupTool(api: OpenClawPluginApi) {
  return (ctx: ToolContext) => ({
    name: "task_pickup",
    label: "Task Pickup",
    description: `Pick up a task from the issue queue. Context-aware: ONLY works in project group chats, not in DMs or during setup. Handles label transition, tier assignment, session creation, task dispatch, and audit logging. Returns an announcement for posting in the group.`,
    parameters: {
      type: "object",
      required: ["issueId", "role", "projectGroupId"],
      properties: {
        issueId: { type: "number", description: "Issue ID to pick up" },
        role: {
          type: "string",
          enum: ["dev", "qa"],
          description: "Worker role: dev or qa",
        },
        projectGroupId: {
          type: "string",
          description:
            "Telegram/WhatsApp group ID (key in projects.json). Required — pass the group ID from the current conversation.",
        },
        model: {
          type: "string",
          description:
            "Developer tier (junior, medior, senior, qa). The orchestrator should evaluate the task complexity and choose the right tier. Falls back to keyword heuristic if omitted.",
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

      // --- Context detection ---
      const devClawAgentIds =
        ((api.pluginConfig as Record<string, unknown>)?.devClawAgentIds as
          | string[]
          | undefined) ?? [];
      const context = await detectContext(ctx, devClawAgentIds);

      // ONLY allow in group context
      if (context.type !== "group") {
        return jsonResult({
          success: false,
          error: "task_pickup can only be used in project group chats.",
          recommendation:
            context.type === "via-agent"
              ? "If you're setting up DevClaw, use devclaw_onboard instead."
              : "To pick up tasks, please use the relevant project's Telegram/WhatsApp group.",
          contextGuidance: generateGuardrails(context),
        });
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
        glabPath: (api.pluginConfig as Record<string, unknown>)?.glabPath as
          | string
          | undefined,
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
        const selected = selectModel(
          issue.title,
          issue.description ?? "",
          role,
        );
        modelAlias = selected.tier;
        modelReason = selected.reason;
        modelSource = "heuristic";
      }

      // 5. Dispatch via shared logic
      const pluginConfig = api.pluginConfig as
        | Record<string, unknown>
        | undefined;
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
        pluginConfig,
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

      return jsonResult(result);
    },
  });
}
