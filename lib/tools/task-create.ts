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
import type { StateLabel } from "../providers/provider.js";
import { DEFAULT_WORKFLOW, getStateLabels, getNotifyLabel, NOTIFY_LABEL_COLOR } from "../workflow.js";
import { requireWorkspaceDir, resolveProject, resolveProvider } from "../tool-helpers.js";

/** Derive the initial state label from the workflow config. */
const INITIAL_LABEL = DEFAULT_WORKFLOW.states[DEFAULT_WORKFLOW.initial].label;

export function createTaskCreateTool(api: OpenClawPluginApi) {
  return (ctx: ToolContext) => ({
    name: "task_create",
    label: "Task Create",
    description: `Create a new task (issue) in the project's issue tracker. Use this to file bugs, features, or tasks from chat.

**IMPORTANT:** Always creates in "${INITIAL_LABEL}" unless the user explicitly asks to start work immediately. Never set label to "To Do" on your own — "${INITIAL_LABEL}" issues require human review before entering the queue.

Examples:
- Default: { title: "Fix login bug" } → created in ${INITIAL_LABEL}
- User says "create and start working": { title: "Implement auth", description: "...", label: "To Do" }`,
    parameters: {
      type: "object",
      required: ["projectSlug", "title"],
      properties: {
        projectSlug: {
          type: "string",
          description: "Project slug (e.g. 'my-webapp')",
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
          description: `State label. Defaults to "${INITIAL_LABEL}" — only use "To Do" when the user explicitly asks to start work immediately.`,
          enum: getStateLabels(DEFAULT_WORKFLOW),
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
      const slug = (params.projectSlug ?? params.projectGroupId) as string;
      const title = params.title as string;
      const description = (params.description as string) ?? "";
      const label = (params.label as StateLabel) ?? INITIAL_LABEL;
      const assignees = (params.assignees as string[] | undefined) ?? [];
      const pickup = (params.pickup as boolean) ?? false;
      const workspaceDir = requireWorkspaceDir(ctx);

      const { project } = await resolveProject(workspaceDir, slug);
      const { provider, type: providerType } = await resolveProvider(project);

      const issue = await provider.createIssue(title, description, label, assignees);

      // Mark as system-managed (best-effort).
      provider.reactToIssue(issue.iid, "eyes").catch(() => {});

      // Apply notify label for channel routing (best-effort).
      const primaryGroupId = project.channels[0]?.groupId;
      if (primaryGroupId) {
        const notifyLabel = getNotifyLabel(primaryGroupId);
        provider.ensureLabel(notifyLabel, NOTIFY_LABEL_COLOR)
          .then(() => provider.addLabel(issue.iid, notifyLabel))
          .catch(() => {}); // best-effort
      }

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
