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
import type { StateLabel } from "../providers/provider.js";
import { DEFAULT_WORKFLOW, getStateLabels, findStateByLabel, getCurrentStateLabel, getRoleLabelColor } from "../workflow.js";
import { loadConfig } from "../config/index.js";
import { requireWorkspaceDir, resolveProject, resolveProvider, autoAssignOwnerLabel } from "../tool-helpers.js";

export function createTaskUpdateTool(api: OpenClawPluginApi) {
  return (ctx: ToolContext) => ({
    name: "task_update",
    label: "Task Update",
    description: `Change issue state and/or role:level assignment. Use this when you need to update an issue's status or override the assigned level.

Use cases:
- Orchestrator or worker needs to change state manually
- Manual status adjustments (e.g., Planning → To Do after approval)
- Override the assigned level (e.g., escalate to senior for human review)
- Force human review via level change
- Failed auto-transitions that need correction

Examples:
- State only: { projectSlug: "my-webapp", issueId: 42, state: "To Do" }
- Level only: { projectSlug: "my-webapp", issueId: 42, level: "senior" }
- Both: { projectSlug: "my-webapp", issueId: 42, state: "To Do", level: "senior", reason: "Escalating to senior" }`,
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
          description: "Issue ID to update",
        },
        state: {
          type: "string",
          enum: getStateLabels(DEFAULT_WORKFLOW),
          description: `New state for the issue. One of: ${getStateLabels(DEFAULT_WORKFLOW).join(", ")}`,
        },
        level: {
          type: "string",
          description: "Override the role:level assignment (e.g., 'senior', 'junior'). Detects role from current state label.",
        },
        reason: {
          type: "string",
          description: "Optional audit log reason for the change",
        },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const slug = (params.projectSlug ?? params.projectGroupId) as string;
      const issueId = params.issueId as number;
      const newState = (params.state as StateLabel) ?? undefined;
      const newLevel = (params.level as string) ?? undefined;
      const reason = (params.reason as string) ?? undefined;
      const workspaceDir = requireWorkspaceDir(ctx);

      if (!newState && !newLevel) {
        throw new Error("At least one of 'state' or 'level' must be provided.");
      }

      const { project } = await resolveProject(workspaceDir, slug);
      const { provider, type: providerType } = await resolveProvider(project);
      const resolvedConfig = await loadConfig(workspaceDir, project.name);

      const issue = await provider.getIssue(issueId);
      const currentState = getCurrentStateLabel(issue.labels, resolvedConfig.workflow);
      if (!currentState) {
        throw new Error(`Issue #${issueId} has no recognized state label. Cannot perform update.`);
      }

      let stateChanged = false;
      let levelChanged = false;
      let fromLevel: string | undefined;

      // Handle state transition
      if (newState && currentState !== newState) {
        await provider.transitionLabel(issueId, currentState, newState);
        stateChanged = true;
      }

      // Handle level override
      if (newLevel) {
        // Detect role from current (or new) state label
        const effectiveState = newState ?? currentState;
        const stateConfig = findStateByLabel(resolvedConfig.workflow, effectiveState);
        const role = stateConfig?.role;
        if (!role) {
          throw new Error(`Cannot determine role from state "${effectiveState}". Level can only be set on role-assigned states.`);
        }

        // Validate level exists for role
        const roleConfig = resolvedConfig.roles[role];
        if (!roleConfig || !roleConfig.levels.includes(newLevel)) {
          throw new Error(`Invalid level "${newLevel}" for role "${role}". Valid levels: ${roleConfig?.levels.join(", ") ?? "none"}`);
        }

        // Remove old role:* labels, add new role:level (preserving slot name if present)
        const oldRoleLabels = issue.labels.filter((l) => l.startsWith(`${role}:`));
        const oldParts = oldRoleLabels[0]?.split(":");
        fromLevel = oldParts?.[1];
        const existingSlotName = oldParts?.[2];
        if (oldRoleLabels.length > 0) {
          await provider.removeLabels(issueId, oldRoleLabels);
        }
        const newRoleLabel = existingSlotName
          ? `${role}:${newLevel}:${existingSlotName}`
          : `${role}:${newLevel}`;
        await provider.ensureLabel(newRoleLabel, getRoleLabelColor(role));
        await provider.addLabel(issueId, newRoleLabel);
        levelChanged = fromLevel !== newLevel;
      }

      // Auto-assign owner label to this instance (best-effort).
      autoAssignOwnerLabel(workspaceDir, provider, issueId, project).catch(() => {});

      // Audit
      await auditLog(workspaceDir, "task_update", {
        project: project.name, issueId,
        ...(stateChanged ? { fromState: currentState, toState: newState } : {}),
        ...(levelChanged ? { fromLevel: fromLevel ?? null, toLevel: newLevel } : {}),
        reason: reason ?? null, provider: providerType,
      });

      // Build announcement
      const parts: string[] = [];
      if (stateChanged) parts.push(`"${currentState}" → "${newState}"`);
      if (levelChanged) parts.push(`level: ${fromLevel ?? "none"} → ${newLevel}`);
      const changeDesc = parts.join(", ");

      return jsonResult({
        success: true, issueId, issueTitle: issue.title,
        ...(newState ? { state: newState } : {}),
        ...(newLevel ? { level: newLevel } : {}),
        changed: stateChanged || levelChanged,
        ...(stateChanged ? { labelTransition: `${currentState} → ${newState}` } : {}),
        project: project.name, provider: providerType,
        announcement: stateChanged || levelChanged
          ? `🔄 Updated #${issueId}: ${changeDesc}${reason ? ` (${reason})` : ""}`
          : `Issue #${issueId} is already in the requested state.`,
      });
    },
  });
}
