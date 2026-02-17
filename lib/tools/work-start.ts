/**
 * work_start — Pick up a task from the issue queue.
 *
 * Context-aware: ONLY works in project group chats.
 * Auto-detects: projectGroupId, role, level, issueId.
 * Picks up only the explicitly requested issue (auto-tick disabled).
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../types.js";
import type { StateLabel } from "../providers/provider.js";
import { selectLevel } from "../model-selector.js";
import { getWorker } from "../projects.js";
import { dispatchTask } from "../dispatch.js";
import { findNextIssue, detectRoleFromLabel, detectRoleLevelFromLabels } from "../services/queue-scan.js";
import { getAllRoleIds, getLevelsForRole } from "../roles/index.js";
import { requireWorkspaceDir, resolveProject, resolveProvider, getPluginConfig } from "../tool-helpers.js";
import { loadWorkflow, getActiveLabel, getNotifyLabel, NOTIFY_LABEL_COLOR, NOTIFY_LABEL_PREFIX, ExecutionMode } from "../workflow.js";

export function createWorkStartTool(api: OpenClawPluginApi) {
  return (ctx: ToolContext) => ({
    name: "work_start",
    label: "Work Start",
    description: `Pick up a task from the issue queue. ONLY works in project group chats. Handles label transition, level assignment, session creation, dispatch, and audit. Picks up only the explicitly requested issue.`,
    parameters: {
      type: "object",
      required: ["projectGroupId"],
      properties: {
        projectGroupId: { type: "string", description: "Project group ID." },
        issueId: { type: "number", description: "Issue ID. If omitted, picks next by priority." },
        role: { type: "string", enum: getAllRoleIds(), description: "Worker role. Auto-detected from label if omitted." },
        level: { type: "string", description: "Worker level (junior/mid/senior). Auto-detected if omitted." },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const issueIdParam = params.issueId as number | undefined;
      const roleParam = params.role as string | undefined;
      const groupId = params.projectGroupId as string;
      const levelParam = (params.level ?? params.tier) as string | undefined;
      const workspaceDir = requireWorkspaceDir(ctx);

      if (!groupId) throw new Error("projectGroupId is required");
      const { project } = await resolveProject(workspaceDir, groupId);
      const { provider } = await resolveProvider(project);

      const workflow = await loadWorkflow(workspaceDir, project.name);

      // Find issue
      let issue: { iid: number; title: string; description: string; labels: string[]; web_url: string; state: string };
      let currentLabel: StateLabel;
      if (issueIdParam !== undefined) {
        issue = await provider.getIssue(issueIdParam);
        const label = provider.getCurrentStateLabel(issue);
        if (!label) throw new Error(`Issue #${issueIdParam} has no recognized state label`);
        currentLabel = label;
      } else {
        const next = await findNextIssue(provider, roleParam, workflow, groupId);
        if (!next) return jsonResult({ success: false, error: `No issues available. Queue is empty.` });
        issue = next.issue;
        currentLabel = next.label;
      }

      // Detect role
      const detectedRole = detectRoleFromLabel(currentLabel, workflow);
      if (!detectedRole) throw new Error(`Label "${currentLabel}" doesn't map to a role`);
      const role = roleParam ?? detectedRole;
      if (roleParam && roleParam !== detectedRole) throw new Error(`Role mismatch: "${currentLabel}" → ${detectedRole}, requested ${roleParam}`);

      // Check worker availability
      const worker = getWorker(project, role);
      if (worker.active) throw new Error(`${role.toUpperCase()} already active on ${project.name} (issue: ${worker.issueId})`);
      if ((project.roleExecution ?? ExecutionMode.PARALLEL) === ExecutionMode.SEQUENTIAL) {
        for (const [otherRole, otherWorker] of Object.entries(project.workers)) {
          if (otherRole !== role && otherWorker.active) {
            throw new Error(`Sequential roleExecution: ${otherRole.toUpperCase()} is active`);
          }
        }
      }

      // Get target label from workflow
      const targetLabel = getActiveLabel(workflow, role);

      // Select level: LLM param → own role label → inherit other role label → heuristic
      let selectedLevel: string, levelReason: string, levelSource: string;
      if (levelParam) {
        selectedLevel = levelParam; levelReason = "LLM-selected"; levelSource = "llm";
      } else {
        const roleLevel = detectRoleLevelFromLabels(issue.labels);
        if (roleLevel?.role === role) {
          selectedLevel = roleLevel.level; levelReason = `Label: "${role}:${roleLevel.level}"`; levelSource = "label";
        } else if (roleLevel && getLevelsForRole(role).includes(roleLevel.level)) {
          selectedLevel = roleLevel.level; levelReason = `Inherited from ${roleLevel.role}:${roleLevel.level}`; levelSource = "inherited";
        } else {
          const s = selectLevel(issue.title, issue.description ?? "", role);
          selectedLevel = s.level; levelReason = s.reason; levelSource = "heuristic";
        }
      }

      // Ensure notify:{groupId} label is on the issue (best-effort — failure must not abort dispatch).
      // This covers issues created via external tools or before this feature was added.
      const notifyLabel = getNotifyLabel(groupId);
      const hasNotify = issue.labels.some(l => l.startsWith(NOTIFY_LABEL_PREFIX));
      if (!hasNotify) {
        provider.ensureLabel(notifyLabel, NOTIFY_LABEL_COLOR)
          .then(() => provider.addLabel(issue.iid, notifyLabel))
          .catch(() => {}); // best-effort
      }

      // Dispatch (pass runtime for direct API access)
      const pluginConfig = getPluginConfig(api);
      const dr = await dispatchTask({
        workspaceDir, agentId: ctx.agentId, groupId, project, issueId: issue.iid,
        issueTitle: issue.title, issueDescription: issue.description ?? "", issueUrl: issue.web_url,
        role, level: selectedLevel, fromLabel: currentLabel, toLabel: targetLabel,
        transitionLabel: (id, from, to) => provider.transitionLabel(id, from as StateLabel, to as StateLabel),
        provider,
        pluginConfig,
        channel: project.channel,
        sessionKey: ctx.sessionKey,
        runtime: api.runtime,
      });

      // Auto-tick disabled per issue #125 - work_start should only pick up the explicitly requested issue
      // The heartbeat service fills parallel slots automatically

      const output: Record<string, unknown> = {
        success: true, project: project.name, groupId, issueId: issue.iid, issueTitle: issue.title,
        role, level: dr.level, model: dr.model, sessionAction: dr.sessionAction,
        announcement: dr.announcement, labelTransition: `${currentLabel} → ${targetLabel}`,
        levelReason, levelSource,
        autoDetected: { role: !roleParam, issueId: issueIdParam === undefined, level: !levelParam },
      };
      // tickPickups removed with auto-tick

      return jsonResult(output);
    },
  });
}
