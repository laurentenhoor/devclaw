/**
 * task_set_level — Set the developer level hint on a HOLD-state issue.
 *
 * Restricted to HOLD states only (Planning, Refining). The level hint is
 * applied as a role:level label and respected by the heartbeat when the
 * issue is later advanced via task_start.
 */
import { jsonResult } from "openclaw/plugin-sdk";
import type { PluginContext } from "../../context.js";
import type { ToolContext } from "../../types.js";
import { log as auditLog } from "../../audit.js";
import { StateType, findStateByLabel, getCurrentStateLabel, getRoleLabelColor } from "../../workflow/index.js";
import { loadConfig } from "../../config/index.js";
import { requireWorkspaceDir, resolveProject, resolveProvider, autoAssignOwnerLabel } from "../helpers.js";

export function createTaskSetLevelTool(ctx: PluginContext) {
  return (toolCtx: ToolContext) => ({
    name: "task_set_level",
    label: "Task Set Level",
    description: `Set the developer level hint on a HOLD-state issue (Planning, Refining). The level is applied as a role:level label and respected by the heartbeat when the issue is advanced via task_start.

Examples:
- { projectSlug: "my-webapp", issueId: 42, level: "senior" }
- { projectSlug: "my-webapp", issueId: 42, level: "junior", reason: "Simple typo fix" }`,
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
        level: {
          type: "string",
          description: "Override the role:level hint (e.g., 'senior', 'junior'). Applied so the heartbeat dispatches with this level when the issue is advanced via task_start.",
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
      const newLevel = (params.level as string) ?? undefined;
      const reason = (params.reason as string) ?? undefined;
      const workspaceDir = requireWorkspaceDir(toolCtx);

      if (!newLevel) {
        throw new Error("'level' is required.");
      }

      const { project } = await resolveProject(workspaceDir, slug);
      const { provider, type: providerType } = await resolveProvider(project, ctx.runCommand);
      const resolvedConfig = await loadConfig(workspaceDir, project.name);

      const issue = await provider.getIssue(issueId);
      const currentState = getCurrentStateLabel(issue.labels, resolvedConfig.workflow);
      if (!currentState) {
        throw new Error(`Issue #${issueId} has no recognized state label. Cannot perform update.`);
      }

      // Restrict to HOLD states only — use task_start for queue/active transitions
      const currentStateConfig = findStateByLabel(resolvedConfig.workflow, currentState);
      if (currentStateConfig?.type !== StateType.HOLD) {
        throw new Error(`task_set_level only works on HOLD states (Planning, Refining). Issue #${issueId} is in "${currentState}". Use task_start to advance issues.`);
      }

      // Apply level hint label (will be respected by heartbeat when task_start advances the issue)
      // Level is applied as a role:level label. Since HOLD states have no role, we look at the
      // APPROVE transition target to determine which role will handle this issue.
      const approveTarget = currentStateConfig.on?.["APPROVE"];
      const targetKey = typeof approveTarget === "string" ? approveTarget : approveTarget?.target;
      const targetState = targetKey ? resolvedConfig.workflow.states[targetKey] : undefined;
      const role = targetState?.role;
      if (!role) {
        throw new Error(`Cannot determine target role from "${currentState}". No APPROVE transition found.`);
      }

      const roleConfig = resolvedConfig.roles[role];
      if (!roleConfig || !roleConfig.levels.includes(newLevel)) {
        throw new Error(`Invalid level "${newLevel}" for role "${role}". Valid: ${roleConfig?.levels.join(", ") ?? "none"}`);
      }

      const oldRoleLabels = issue.labels.filter((l) => l.startsWith(`${role}:`));
      const fromLevel = oldRoleLabels[0]?.split(":")[1];
      if (oldRoleLabels.length > 0) {
        await provider.removeLabels(issueId, oldRoleLabels);
      }
      const newRoleLabel = `${role}:${newLevel}`;
      await provider.ensureLabel(newRoleLabel, getRoleLabelColor(role));
      await provider.addLabel(issueId, newRoleLabel);
      const levelChanged = fromLevel !== newLevel;

      // Auto-assign owner label to this instance (best-effort).
      autoAssignOwnerLabel(workspaceDir, provider, issueId, project).catch(() => {});

      await auditLog(workspaceDir, "task_set_level", {
        project: project.name, issueId,
        ...(levelChanged ? { fromLevel: fromLevel ?? null, toLevel: newLevel } : {}),
        reason: reason ?? null, provider: providerType,
      });

      return jsonResult({
        success: true, issueId, issueTitle: issue.title,
        level: newLevel, changed: levelChanged,
        project: project.name, provider: providerType,
        announcement: levelChanged
          ? `🔄 Updated #${issueId}: level ${fromLevel ?? "none"} → ${newLevel}${reason ? ` (${reason})` : ""}`
          : `Issue #${issueId} already has level "${newLevel}".`,
      });
    },
  });
}
