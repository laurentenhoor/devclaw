/**
 * work_finish — Complete a task (DEV done, QA pass/fail/refine/blocked).
 *
 * Delegates side-effects to pipeline service: label transition, state update,
 * issue close/reopen, notifications, and audit logging.
 *
 * Roles without workflow states (e.g. architect) are handled inline —
 * deactivate worker, optionally transition label, and notify.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../types.js";
import type { StateLabel } from "../providers/provider.js";
import { deactivateWorker, getWorker, resolveRepoPath } from "../projects.js";
import { executeCompletion, getRule } from "../services/pipeline.js";
import { log as auditLog } from "../audit.js";
import { requireWorkspaceDir, resolveProject, resolveProvider, getPluginConfig } from "../tool-helpers.js";
import { getAllRoleIds, isValidResult, getCompletionResults } from "../roles/index.js";
import { loadWorkflow, hasWorkflowStates, getCompletionEmoji } from "../workflow.js";
import { notify, getNotificationConfig } from "../notify.js";

export function createWorkFinishTool(api: OpenClawPluginApi) {
  return (ctx: ToolContext) => ({
    name: "work_finish",
    label: "Work Finish",
    description: `Complete a task: Developer done (PR created, goes to review) or blocked. Tester pass/fail/refine/blocked. Reviewer approve/reject/blocked. Architect done/blocked. Handles label transition, state update, issue close/reopen, notifications, and audit logging.`,
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

      // Resolve project + worker
      const { project } = await resolveProject(workspaceDir, groupId);
      const worker = getWorker(project, role);
      if (!worker.active) throw new Error(`${role.toUpperCase()} worker not active on ${project.name}`);

      const issueId = worker.issueId ? Number(worker.issueId.split(",")[0]) : null;

      const { provider } = await resolveProvider(project);
      const workflow = await loadWorkflow(workspaceDir, project.name);

      // Roles without workflow states (e.g. architect) — handle inline
      if (!hasWorkflowStates(workflow, role)) {
        // Research mode: architect dispatched without a pre-existing issue.
        // work_finish creates the Planning issue with findings from summary.
        if (!issueId) {
          return handleResearchCompletion({
            workspaceDir, groupId, role, result, summary,
            metadata: worker.metadata,
            provider, projectName: project.name, channel: project.channel,
            pluginConfig: getPluginConfig(api), runtime: api.runtime,
          });
        }
        return handleStatelessCompletion({
          workspaceDir, groupId, role, result, issueId, summary,
          provider, projectName: project.name, channel: project.channel,
          pluginConfig: getPluginConfig(api), runtime: api.runtime,
        });
      }

      if (!issueId) throw new Error(`No issueId for active ${role.toUpperCase()} on ${project.name}`);

      // Standard pipeline completion for roles with workflow states
      if (!getRule(role, result))
        throw new Error(`Invalid completion: ${role}:${result}`);

      const repoPath = resolveRepoPath(project.repo);
      const pluginConfig = getPluginConfig(api);

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

      await auditLog(workspaceDir, "work_finish", {
        project: project.name, groupId, issue: issueId, role, result,
        summary: summary ?? null, labelTransition: completion.labelTransition,
      });

      return jsonResult(output);
    },
  });
}

/**
 * Handle completion for roles without workflow states (e.g. architect).
 *
 * - done: deactivate worker, issue stays in current state (Planning)
 * - blocked: deactivate worker, transition issue to Refining
 */
async function handleStatelessCompletion(opts: {
  workspaceDir: string;
  groupId: string;
  role: string;
  result: string;
  issueId: number;
  summary?: string;
  provider: import("../providers/provider.js").IssueProvider;
  projectName: string;
  channel?: string;
  pluginConfig?: Record<string, unknown>;
  runtime?: import("openclaw/plugin-sdk").PluginRuntime;
}): Promise<ReturnType<typeof jsonResult>> {
  const {
    workspaceDir, groupId, role, result, issueId, summary,
    provider, projectName, channel, pluginConfig, runtime,
  } = opts;

  const issue = await provider.getIssue(issueId);

  // Deactivate worker
  await deactivateWorker(workspaceDir, groupId, role);

  // If blocked, transition to Refining
  let labelTransition = "none";
  if (result === "blocked") {
    const currentLabel = provider.getCurrentStateLabel(issue) ?? "Planning";
    await provider.transitionLabel(issueId, currentLabel as StateLabel, "Refining" as StateLabel);
    labelTransition = `${currentLabel} → Refining`;
  }

  // Notification
  const nextState = result === "blocked" ? "awaiting human decision" : "awaiting human decision";
  const notifyConfig = getNotificationConfig(pluginConfig);
  notify(
    {
      type: "workerComplete",
      project: projectName,
      groupId,
      issueId,
      issueUrl: issue.web_url,
      role,
      result: result as "done" | "blocked",
      summary,
      nextState,
    },
    {
      workspaceDir,
      config: notifyConfig,
      groupId,
      channel: channel ?? "telegram",
      runtime,
    },
  ).catch((err) => {
    auditLog(workspaceDir, "pipeline_warning", { step: "notify", issue: issueId, role, error: (err as Error).message ?? String(err) }).catch(() => {});
  });

  // Build announcement
  const emoji = getCompletionEmoji(role, result);
  const label = `${role} ${result}`.toUpperCase();
  let announcement = `${emoji} ${label} #${issueId}`;
  if (summary) announcement += ` — ${summary}`;
  announcement += `\n📋 Issue: ${issue.web_url}`;
  if (result === "blocked") announcement += `\nawaiting human decision.`;

  // Audit
  await auditLog(workspaceDir, "work_finish", {
    project: projectName, groupId, issue: issueId, role, result,
    summary: summary ?? null, labelTransition,
  });

  return jsonResult({
    success: true, project: projectName, groupId, issueId, role, result,
    labelTransition,
    announcement,
    nextState,
    issueUrl: issue.web_url,
  });
}

/**
 * Handle research completion — architect dispatched without a pre-existing issue.
 *
 * - done: create Planning issue with findings (summary) as body, deactivate worker
 * - blocked: create Planning issue with partial findings, deactivate worker
 *
 * The summary becomes the issue body so findings are integrated, not scattered as comments.
 */
async function handleResearchCompletion(opts: {
  workspaceDir: string;
  groupId: string;
  role: string;
  result: string;
  summary?: string;
  metadata?: Record<string, unknown>;
  provider: import("../providers/provider.js").IssueProvider;
  projectName: string;
  channel?: string;
  pluginConfig?: Record<string, unknown>;
  runtime?: import("openclaw/plugin-sdk").PluginRuntime;
}): Promise<ReturnType<typeof jsonResult>> {
  const {
    workspaceDir, groupId, role, result, summary,
    metadata, provider, projectName, channel, pluginConfig, runtime,
  } = opts;

  // Extract research context from worker metadata
  const researchTitle = (metadata?.researchTitle as string | undefined) ?? "Research findings";
  const researchDescription = (metadata?.researchDescription as string | undefined) ?? "";
  const focusAreas = (metadata?.focusAreas as string[] | undefined) ?? [];

  // Build issue body: findings first, original context below
  const bodyParts: string[] = [];

  if (result === "blocked") {
    bodyParts.push("## Status", "", "⚠️ Research blocked — partial findings below. Human review needed.", "");
  }

  if (summary) {
    bodyParts.push("## Findings", "", summary);
  } else {
    bodyParts.push("## Findings", "", "_No summary provided._");
  }

  if (researchDescription) {
    bodyParts.push("", "---", "", "## Original Context", "", researchDescription);
  }

  if (focusAreas.length > 0) {
    bodyParts.push("", "## Focus Areas", ...focusAreas.map((a) => `- ${a}`));
  }

  const issueBody = bodyParts.join("\n");

  // Create Planning issue with findings as the body
  const issue = await provider.createIssue(researchTitle, issueBody, "Planning" as StateLabel);

  // Deactivate worker (clears metadata too)
  await deactivateWorker(workspaceDir, groupId, role);

  // Notification
  const nextState = "awaiting human review";
  const notifyConfig = getNotificationConfig(pluginConfig);
  notify(
    {
      type: "workerComplete",
      project: projectName,
      groupId,
      issueId: issue.iid,
      issueUrl: issue.web_url,
      role,
      result: result as "done" | "blocked",
      summary,
      nextState,
    },
    {
      workspaceDir,
      config: notifyConfig,
      groupId,
      channel: channel ?? "telegram",
      runtime,
    },
  ).catch((err) => {
    auditLog(workspaceDir, "pipeline_warning", {
      step: "notify", role,
      error: (err as Error).message ?? String(err),
    }).catch(() => {});
  });

  // Build announcement
  const emoji = getCompletionEmoji(role, result);
  const verb = result === "done" ? "Research complete" : "Research blocked";
  let announcement = `${emoji} ${verb} — created Planning issue #${issue.iid}: ${researchTitle}`;
  announcement += `\n🔗 ${issue.web_url}`;
  if (result === "blocked") announcement += `\n⚠️ Needs human review.`;

  // Audit
  await auditLog(workspaceDir, "work_finish", {
    project: projectName, groupId, issue: issue.iid, role, result,
    summary: summary ?? null, labelTransition: "none → Planning (created)",
    researchTitle,
  });

  return jsonResult({
    success: true, project: projectName, groupId, issueId: issue.iid, role, result,
    labelTransition: "none → Planning (created)",
    announcement,
    nextState,
    issueUrl: issue.web_url,
  });
}
