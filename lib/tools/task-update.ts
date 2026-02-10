/**
 * task_update — Change issue state programmatically.
 *
 * Use cases:
 * - Orchestrator or worker needs to change state without full pickup/complete flow
 * - Manual status adjustments (e.g., Planning → To Do after approval)
 * - Failed auto-transitions that need correction
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../types.js";
import { log as auditLog } from "../audit.js";
import { STATE_LABELS, type StateLabel } from "../providers/provider.js";
import { requireWorkspaceDir, resolveProject, resolveProvider } from "../tool-helpers.js";

export function createTaskUpdateTool(api: OpenClawPluginApi) {
  return (ctx: ToolContext) => ({
    name: "task_update",
    label: "Task Update",
    description: `Change issue state programmatically. Use this when you need to update an issue's status without going through the full pickup/complete flow.

Use cases:
- Orchestrator or worker needs to change state manually
- Manual status adjustments (e.g., Planning → To Do after approval)
- Failed auto-transitions that need correction
- Bulk state changes

Examples:
- Simple: { projectGroupId: "-123456789", issueId: 42, state: "To Do" }
- With reason: { projectGroupId: "-123456789", issueId: 42, state: "To Do", reason: "Approved for development" }`,
    parameters: {
      type: "object",
      required: ["projectGroupId", "issueId", "state"],
      properties: {
        projectGroupId: {
          type: "string",
          description: "Telegram/WhatsApp group ID (key in projects.json)",
        },
        issueId: {
          type: "number",
          description: "Issue ID to update",
        },
        state: {
          type: "string",
          enum: STATE_LABELS,
          description: `New state for the issue. One of: ${STATE_LABELS.join(", ")}`,
        },
        reason: {
          type: "string",
          description: "Optional audit log reason for the state change",
        },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const groupId = params.projectGroupId as string;
      const issueId = params.issueId as number;
      const newState = params.state as StateLabel;
      const reason = (params.reason as string) ?? undefined;
      const workspaceDir = requireWorkspaceDir(ctx);

      const { project } = await resolveProject(workspaceDir, groupId);
      const { provider, type: providerType } = resolveProvider(project);

      const issue = await provider.getIssue(issueId);
      const currentState = provider.getCurrentStateLabel(issue);
      if (!currentState) {
        throw new Error(`Issue #${issueId} has no recognized state label. Cannot perform transition.`);
      }

      if (currentState === newState) {
        return jsonResult({
          success: true, issueId, state: newState, changed: false,
          message: `Issue #${issueId} is already in state "${newState}".`,
          project: project.name, provider: providerType,
        });
      }

      await provider.transitionLabel(issueId, currentState, newState);

      await auditLog(workspaceDir, "task_update", {
        project: project.name, groupId, issueId,
        fromState: currentState, toState: newState,
        reason: reason ?? null, provider: providerType,
      });

      return jsonResult({
        success: true, issueId, issueTitle: issue.title,
        state: newState, changed: true,
        labelTransition: `${currentState} → ${newState}`,
        project: project.name, provider: providerType,
        announcement: `🔄 Updated #${issueId}: "${currentState}" → "${newState}"${reason ? ` (${reason})` : ""}`,
      });
    },
  });
}
