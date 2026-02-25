/**
 * task_start — Advance an issue to the next queue in the workflow.
 *
 * State-agnostic: looks at the issue's current state and uses the workflow
 * transitions to determine the correct queue. Optionally applies a level hint
 * label so the heartbeat dispatches with the desired level.
 *
 * The heartbeat is the sole dispatcher — this tool only places issues in
 * queues, never dispatches workers directly.
 */
import { jsonResult } from "openclaw/plugin-sdk";
import type { PluginContext } from "../../context.js";
import type { ToolContext } from "../../types.js";
import { log as auditLog } from "../../audit.js";
import {
  StateType,
  WorkflowEvent,
  type StateConfig,
  type WorkflowConfig,
} from "../../workflow/types.js";
import {
  getCurrentStateLabel,
  findStateByLabel,
  findStateKeyByLabel,
  getRoleLabelColor,
} from "../../workflow/index.js";
import { getLevelsForRole } from "../../roles/index.js";
import { loadConfig } from "../../config/index.js";
import { requireWorkspaceDir, resolveProject, resolveProvider, autoAssignOwnerLabel, applyNotifyLabel } from "../helpers.js";

export function createTaskStartTool(ctx: PluginContext) {
  return (toolCtx: ToolContext) => ({
    name: "task_start",
    label: "Task Start",
    description: `Advance an issue to the next queue in the workflow. State-agnostic: works from any state (Planning, Refining, To Do, etc.) and determines the correct queue automatically using workflow transitions.

Optionally set a level hint (e.g. "junior", "senior") so the heartbeat dispatches with the desired level. The heartbeat handles the actual dispatch — this tool only places issues in queues.

Examples:
- Start work: { projectSlug: "my-app", issueId: 42 } → advances to next queue
- With level: { projectSlug: "my-app", issueId: 42, level: "junior" } → advances + hints junior`,
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
          description: "Issue ID to advance.",
        },
        level: {
          type: "string",
          description: "Optional level hint for dispatch (e.g. 'junior', 'senior'). Applied as a label so the heartbeat respects it.",
        },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const slug = (params.projectSlug ?? params.projectGroupId) as string;
      const issueId = params.issueId as number;
      const levelHint = params.level as string | undefined;
      const workspaceDir = requireWorkspaceDir(toolCtx);

      const { project } = await resolveProject(workspaceDir, slug);
      const { provider } = await resolveProvider(project, ctx.runCommand);
      const resolvedConfig = await loadConfig(workspaceDir, project.name);
      const workflow = resolvedConfig.workflow;

      const issue = await provider.getIssue(issueId);
      const currentLabel = getCurrentStateLabel(issue.labels, workflow);
      if (!currentLabel) {
        throw new Error(`Issue #${issueId} has no recognized state label.`);
      }

      const currentState = findStateByLabel(workflow, currentLabel);
      if (!currentState) {
        throw new Error(`No state config for label "${currentLabel}".`);
      }

      // Determine target based on current state type
      const { targetLabel, targetState, transitioned } = resolveTarget(
        workflow, currentLabel, currentState,
      );

      // Transition label if needed
      if (transitioned) {
        await provider.transitionLabel(issueId, currentLabel, targetLabel);
      }

      // Apply level hint label if provided
      const targetRole = targetState.role;
      if (levelHint && targetRole) {
        const validLevels = getLevelsForRole(targetRole);
        if (!validLevels.includes(levelHint)) {
          throw new Error(`Invalid level "${levelHint}" for role "${targetRole}". Valid: ${validLevels.join(", ")}`);
        }
        // Remove old role:* labels, apply new hint
        const oldRoleLabels = issue.labels.filter((l) => l.startsWith(`${targetRole}:`));
        if (oldRoleLabels.length > 0) {
          await provider.removeLabels(issueId, oldRoleLabels);
        }
        const hintLabel = `${targetRole}:${levelHint}`;
        await provider.ensureLabel(hintLabel, getRoleLabelColor(targetRole));
        await provider.addLabel(issueId, hintLabel);
      }

      // Ensure notify label is on the issue (best-effort)
      applyNotifyLabel(provider, issueId, project, slug, issue.labels);

      // Auto-assign owner label (best-effort)
      autoAssignOwnerLabel(workspaceDir, provider, issueId, project).catch(() => {});

      await auditLog(workspaceDir, "task_start", {
        project: project.name, issueId,
        from: currentLabel, to: targetLabel,
        transitioned, level: levelHint ?? null,
      });

      const levelMsg = levelHint ? ` (level hint: ${levelHint})` : "";
      const announcement = transitioned
        ? `▶️ #${issueId} moved to "${targetLabel}"${levelMsg} — heartbeat will dispatch.`
        : `▶️ #${issueId} already in queue "${targetLabel}"${levelMsg} — heartbeat will dispatch.`;

      return jsonResult({
        success: true, issueId, issueTitle: issue.title,
        from: currentLabel, to: targetLabel, transitioned,
        level: levelHint ?? null,
        project: project.name, announcement,
      });
    },
  });
}

/**
 * Resolve the target queue state based on current state type.
 *
 * - HOLD: follow APPROVE transition → target queue
 * - QUEUE: already in queue, no transition
 * - ACTIVE: error (already being worked on)
 * - TERMINAL: error (issue is closed)
 */
function resolveTarget(
  workflow: WorkflowConfig,
  currentLabel: string,
  currentState: StateConfig,
): { targetLabel: string; targetState: StateConfig; transitioned: boolean } {
  switch (currentState.type) {
    case StateType.HOLD: {
      const approveTransition = currentState.on?.[WorkflowEvent.APPROVE];
      if (!approveTransition) {
        throw new Error(`HOLD state "${currentLabel}" has no APPROVE transition.`);
      }
      const targetKey = typeof approveTransition === "string"
        ? approveTransition
        : approveTransition.target;
      const targetState = workflow.states[targetKey];
      if (!targetState) {
        throw new Error(`Transition target "${targetKey}" not found in workflow.`);
      }
      return { targetLabel: targetState.label, targetState, transitioned: true };
    }

    case StateType.QUEUE:
      return { targetLabel: currentLabel, targetState: currentState, transitioned: false };

    case StateType.ACTIVE:
      throw new Error(`Issue is in active state "${currentLabel}" — already being worked on.`);

    case StateType.TERMINAL:
      throw new Error(`Issue is in terminal state "${currentLabel}" — cannot start.`);

    default:
      throw new Error(`Unknown state type for "${currentLabel}".`);
  }
}
