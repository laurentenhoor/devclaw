/**
 * task_create — Create a new task (issue) in the project's issue tracker.
 *
 * Atomically: creates an issue with the specified title, description, and label.
 * Returns the created issue for immediate pickup if desired.
 *
 * Use this when:
 * - You want to create work items from chat
 * - A sub-agent finds a bug and needs to file a follow-up issue
 * - Breaking down an epic into smaller tasks
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../types.js";
import { log as auditLog } from "../audit.js";
import { STATE_LABELS, type StateLabel } from "../providers/provider.js";
import { requireWorkspaceDir, resolveProject, resolveProvider } from "../tool-helpers.js";

export function createTaskCreateTool(api: OpenClawPluginApi) {
  return (ctx: ToolContext) => ({
    name: "task_create",
    label: "Task Create",
    description: `Create a new task (issue) in the project's issue tracker. Use this to file bugs, features, or tasks from chat.

**IMPORTANT:** Always creates in "Planning" unless the user explicitly asks to start work immediately. Never set label to "To Do" on your own — "Planning" issues require human review before entering the queue.

Examples:
- Default: { title: "Fix login bug" } → created in Planning
- User says "create and start working": { title: "Implement auth", description: "...", label: "To Do" }`,
    parameters: {
      type: "object",
      required: ["projectGroupId", "title"],
      properties: {
        projectGroupId: {
          type: "string",
          description: "Telegram/WhatsApp group ID for the project",
        },
        title: {
          type: "string",
          description: "Short, descriptive issue title (e.g., 'Fix login timeout bug')",
        },
        description: {
          type: "string",
          description: "Full issue body in markdown. Use for detailed context, acceptance criteria, reproduction steps, links. Supports GitHub-flavored markdown.",
        },
        label: {
          type: "string",
          description: `State label. Defaults to "Planning" — only use "To Do" when the user explicitly asks to start work immediately.`,
          enum: STATE_LABELS,
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
      const groupId = params.projectGroupId as string;
      const title = params.title as string;
      const description = (params.description as string) ?? "";
      const label = (params.label as StateLabel) ?? "Planning";
      const assignees = (params.assignees as string[] | undefined) ?? [];
      const pickup = (params.pickup as boolean) ?? false;
      const workspaceDir = requireWorkspaceDir(ctx);

      const { project } = await resolveProject(workspaceDir, groupId);
      const { provider, type: providerType } = await resolveProvider(project);

      const issue = await provider.createIssue(title, description, label, assignees);

      await auditLog(workspaceDir, "task_create", {
        project: project.name, groupId, issueId: issue.iid,
        title, label, provider: providerType, pickup,
      });

      const hasBody = description && description.trim().length > 0;
      let announcement = `📋 Created #${issue.iid}: "${title}" (${label})`;
      if (hasBody) announcement += "\nWith detailed description.";
      announcement += `\n🔗 ${issue.web_url}`;
      announcement += pickup ? "\nPicking up for DEV..." : "\nReady for pickup when needed.";

      return jsonResult({
        success: true,
        issue: { id: issue.iid, title: issue.title, body: hasBody ? description : null, url: issue.web_url, label },
        project: project.name, provider: providerType, pickup, announcement,
      });
    },
  });
}
