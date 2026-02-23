/**
 * task_edit_body — Update issue title and/or description in the initial workflow state.
 *
 * Only allowed when the issue is in the first state of the workflow (e.g. "Planning").
 * This prevents inadvertent edits to issues that are already in-progress.
 *
 * Provider (GitHub/GitLab) tracks revision history natively.
 * DevClaw adds an explicit audit entry with who, when, and what changed.
 * Optionally posts an auto-comment on the issue for traceability.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../types.js";
import { log as auditLog } from "../audit.js";
import { loadConfig } from "../config/index.js";
import { getInitialStateLabel, getCurrentStateLabel } from "../workflow.js";
import { requireWorkspaceDir, resolveProject, resolveProvider, autoAssignOwnerLabel } from "../tool-helpers.js";

export function createTaskEditBodyTool(_api: OpenClawPluginApi) {
  return (ctx: ToolContext) => ({
    name: "task_edit_body",
    label: "Task Edit Body",
    description: `Update issue title and/or description. Only allowed in the initial workflow state (e.g. "Planning") — prevents editing in-progress work.

Logs the edit to the audit trail with timestamp, caller, and a diff summary.
Optionally posts an auto-comment on the issue for traceability.

Examples:
- Fix typo: { projectSlug: "my-webapp", issueId: 42, title: "Fix login timeout bug" }
- Clarify scope: { projectSlug: "my-webapp", issueId: 42, body: "Updated requirements...", reason: "Clarified after meeting" }
- Silent edit: { projectSlug: "my-webapp", issueId: 42, body: "...", addComment: false }`,
    parameters: {
      type: "object",
      required: ["projectSlug", "issueId"],
      properties: {
        projectSlug: {
          type: "string",
          description: "Project slug (e.g. 'my-webapp').",
        },
        issueId: {
          type: "number",
          description: "Issue ID to edit",
        },
        title: {
          type: "string",
          description: "New title for the issue (optional)",
        },
        body: {
          type: "string",
          description: "New body/description for the issue (optional)",
        },
        reason: {
          type: "string",
          description: "Why the edit was made (optional, for audit trail)",
        },
        addComment: {
          type: "boolean",
          description: "Post an auto-comment on the issue noting the edit (default: true)",
        },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const slug = (params.projectSlug ?? params.projectGroupId) as string;
      const issueId = params.issueId as number;
      const newTitle = (params.title as string | undefined);
      const newBody = (params.body as string | undefined);
      const reason = (params.reason as string | undefined);
      const addComment = (params.addComment as boolean | undefined) ?? true;
      const workspaceDir = requireWorkspaceDir(ctx);

      if (!newTitle && !newBody) {
        throw new Error("At least one of 'title' or 'body' must be provided.");
      }

      const { project } = await resolveProject(workspaceDir, slug);
      const { provider, type: providerType } = await resolveProvider(project);

      // Determine editable states from per-project workflow config.
      // Edits are allowed in:
      //   1. The initial state (e.g. "Planning") — human-created issues awaiting review
      //   2. Any active architect state (e.g. "Researching") — architect refines mid-research
      const resolvedConfig = await loadConfig(workspaceDir, project.name);
      const initialStateLabel = getInitialStateLabel(resolvedConfig.workflow);

      // Collect architect active states as additional editable states
      const architectActiveStates = Object.values(resolvedConfig.workflow.states)
        .filter((s) => s.type === "active" && s.role === "architect")
        .map((s) => s.label);
      const editableStates = [initialStateLabel, ...architectActiveStates];

      // Fetch current issue
      const issue = await provider.getIssue(issueId);
      const currentState = getCurrentStateLabel(issue.labels, resolvedConfig.workflow);

      // Enforce editable-states constraint
      if (!currentState || !editableStates.includes(currentState)) {
        throw new Error(
          `Cannot edit issue #${issueId}: it is in "${currentState ?? "unknown"}", ` +
          `but edits are only allowed in: ${editableStates.map(s => `"${s}"`).join(", ")}. ` +
          `Add a comment instead, or transition the issue first.`,
        );
      }

      // Track what changes we're making
      const changes: Record<string, { from: string; to: string }> = {};
      if (newTitle !== undefined && newTitle !== issue.title) {
        changes.title = { from: issue.title, to: newTitle };
      }
      if (newBody !== undefined && newBody !== issue.description) {
        changes.body = { from: issue.description, to: newBody };
      }

      // Nothing actually changed
      if (Object.keys(changes).length === 0) {
        return jsonResult({
          success: true,
          issueId,
          issueUrl: issue.web_url,
          project: project.name,
          changed: false,
          announcement: `Issue #${issueId} already has the requested content — no changes made.\n🔗 [Issue #${issueId}](${issue.web_url})`,
        });
      }

      // Apply the edit
      const updatedIssue = await provider.editIssue(issueId, {
        ...(newTitle !== undefined ? { title: newTitle } : {}),
        ...(newBody !== undefined ? { body: newBody } : {}),
      });

      // Auto-assign owner label to this instance (best-effort).
      autoAssignOwnerLabel(workspaceDir, provider, issueId, project).catch(() => {});

      // Post auto-comment for traceability (best-effort — must not abort on failure)
      if (addComment) {
        const timestamp = new Date().toISOString();
        const changeLines: string[] = [];
        if (changes.title) {
          changeLines.push(`- **Title** updated`);
        }
        if (changes.body) {
          changeLines.push(`- **Description** updated`);
        }
        const commentBody = [
          `📝 **Issue updated** at ${timestamp}`,
          ...changeLines,
          ...(reason ? [`- **Reason:** ${reason}`] : []),
        ].join("\n");

        provider.addComment(issueId, commentBody).then((commentId) => {
          provider.reactToIssueComment(issueId, commentId, "eyes").catch(() => {});
        }).catch((err) => {
          auditLog(workspaceDir, "task_edit_body_warning", {
            step: "addComment", issueId, error: (err as Error).message ?? String(err),
          }).catch(() => {});
        });
      }

      // Audit log
      await auditLog(workspaceDir, "task_edit_body", {
        project: project.name,
        issueId,
        issueUrl: updatedIssue.web_url,
        provider: providerType,
        changes: Object.fromEntries(
          Object.entries(changes).map(([k, v]) => [k, { from: v.from.slice(0, 200), to: v.to.slice(0, 200) }]),
        ),
        reason: reason ?? null,
        timestamp: new Date().toISOString(),
      });

      // Build change summary for announcement
      const changedFields = Object.keys(changes).join(" and ");
      let announcement = `✏️ Updated ${changedFields} of #${issueId}: "${updatedIssue.title}"`;
      if (reason) announcement += ` — ${reason}`;
      announcement += `\n🔗 [Issue #${issueId}](${updatedIssue.web_url})`;

      return jsonResult({
        success: true,
        issueId,
        issueTitle: updatedIssue.title,
        issueUrl: updatedIssue.web_url,
        project: project.name,
        provider: providerType,
        changed: true,
        changes: Object.keys(changes),
        announcement,
      });
    },
  });
}
