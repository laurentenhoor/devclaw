/**
 * task_create — Create a new task (issue) in the project's issue tracker.
 *
 * Atomically: creates an issue with the specified title and description in the
 * initial workflow state. Returns the created issue for immediate pickup if desired.
 *
 * Use this when:
 * - You want to create work items from chat
 * - A sub-agent finds a bug and needs to file a follow-up issue
 * - Breaking down an epic into smaller tasks
 */
import { jsonResult } from "openclaw/plugin-sdk";
import type { PluginContext } from "../../context.js";
import type { ToolContext } from "../../types.js";
import { log as auditLog } from "../../audit.js";
import { DEFAULT_WORKFLOW } from "../../workflow/index.js";
import { requireWorkspaceDir, resolveChannelId, resolveProject, resolveProvider, autoAssignOwnerLabel, applyNotifyLabel } from "../helpers.js";

/** Derive the initial state label from the workflow config. */
const INITIAL_LABEL = DEFAULT_WORKFLOW.states[DEFAULT_WORKFLOW.initial].label;

export function createTaskCreateTool(ctx: PluginContext) {
  return (toolCtx: ToolContext) => ({
    name: "task_create",
    label: "Task Create",
    description: `Create a new task (issue) in the project's issue tracker. Use this to file bugs, features, or tasks from chat. Issues are created in "${INITIAL_LABEL}" state for human review before entering the queue.`,
    parameters: {
      type: "object",
      required: ["channelId", "title"],
      properties: {
        channelId: {
          type: "string",
          description: "YOUR chat/group ID — the numeric ID of the chat you are in right now (e.g. '-1003844794417'). Do NOT guess; use the ID of the conversation this message came from.",
        },
        title: {
          type: "string",
          description: "Short, descriptive issue title (e.g., 'Fix login timeout bug')",
        },
        description: {
          type: "string",
          description: "Full issue body in markdown. Use for detailed context, acceptance criteria, reproduction steps, links. Supports GitHub-flavored markdown.",
        },
        assignees: {
          type: "array",
          items: { type: "string" },
          description: "GitHub/GitLab usernames to assign (optional)",
        },
        pickup: {
          type: "boolean",
          description: "If true, immediately pick up this issue for DEV after creation. Defaults to false.",
        },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const channelId = resolveChannelId(toolCtx, params.channelId as string | undefined);
      const title = params.title as string;
      const description = (params.description as string) ?? "";
      const label = INITIAL_LABEL;
      const assignees = (params.assignees as string[] | undefined) ?? [];
      const pickup = (params.pickup as boolean) ?? false;
      const workspaceDir = requireWorkspaceDir(toolCtx);

      const { project } = await resolveProject(workspaceDir, channelId);
      const { provider, type: providerType } = await resolveProvider(project, ctx.runCommand);

      const issue = await provider.createIssue(title, description, label, assignees);

      // Mark as system-managed (best-effort).
      provider.reactToIssue(issue.iid, "eyes").catch(() => {});

      // Apply notify label for channel routing (best-effort).
      applyNotifyLabel(provider, issue.iid, project, channelId);

      // Auto-assign owner label to this instance (best-effort).
      autoAssignOwnerLabel(workspaceDir, provider, issue.iid, project).catch(() => {});

      await auditLog(workspaceDir, "task_create", {
        project: project.name, issueId: issue.iid,
        title, label, provider: providerType, pickup,
      });

      const hasBody = description && description.trim().length > 0;
      let announcement = `📋 Created #${issue.iid}: "${title}" (${label})`;
      if (hasBody) announcement += "\nWith detailed description.";
      announcement += `\n🔗 [Issue #${issue.iid}](${issue.web_url})`;
      announcement += pickup ? "\nPicking up for DEV..." : "\nReady for pickup when needed.";

      return jsonResult({
        success: true,
        issue: { id: issue.iid, title: issue.title, body: hasBody ? description : null, url: issue.web_url, label },
        project: project.name, provider: providerType, pickup, announcement,
      });
    },
  });
}
