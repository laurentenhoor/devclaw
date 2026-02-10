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
import { notify, getNotificationConfig } from "../notify.js";
import { findNextIssue, detectRoleFromLabel, detectLevelFromLabels } from "../services/tick.js";
import { isDevLevel } from "../tiers.js";
import { requireWorkspaceDir, resolveContext, resolveProject, resolveProvider, groupOnlyError, getPluginConfig, tickAndNotify } from "../tool-helpers.js";

export function createWorkStartTool(api: OpenClawPluginApi) {
  return (ctx: ToolContext) => ({
    name: "work_start",
    label: "Work Start",
    description: `Pick up a task from the issue queue. ONLY works in project group chats. Handles label transition, level assignment, session creation, dispatch, and audit. Picks up only the explicitly requested issue.`,
    parameters: {
      type: "object",
      properties: {
        issueId: { type: "number", description: "Issue ID. If omitted, picks next by priority." },
        role: { type: "string", enum: ["dev", "qa"], description: "Worker role. Auto-detected from label if omitted." },
        projectGroupId: { type: "string", description: "Project group ID. Auto-detected from group context." },
        level: { type: "string", description: "Developer level (junior/medior/senior/reviewer). Auto-detected if omitted." },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const issueIdParam = params.issueId as number | undefined;
      const roleParam = params.role as "dev" | "qa" | undefined;
      const groupIdParam = params.projectGroupId as string | undefined;
      const levelParam = (params.level ?? params.tier) as string | undefined;
      const workspaceDir = requireWorkspaceDir(ctx);

      // Context guard: group only
      const context = await resolveContext(ctx, api);
      if (context.type !== "group") return groupOnlyError("work_start", context);

      const groupId = groupIdParam ?? context.groupId;
      const { project } = await resolveProject(workspaceDir, groupId);
      const { provider } = resolveProvider(project);

      // Find issue
      let issue: { iid: number; title: string; description: string; labels: string[]; web_url: string; state: string };
      let currentLabel: StateLabel;
      if (issueIdParam !== undefined) {
        issue = await provider.getIssue(issueIdParam);
        const label = provider.getCurrentStateLabel(issue);
        if (!label) throw new Error(`Issue #${issueIdParam} has no recognized state label`);
        currentLabel = label;
      } else {
        const next = await findNextIssue(provider, roleParam);
        if (!next) return jsonResult({ success: false, error: `No issues available. Queue is empty.` });
        issue = next.issue;
        currentLabel = next.label;
      }

      // Detect role
      const detectedRole = detectRoleFromLabel(currentLabel);
      if (!detectedRole) throw new Error(`Label "${currentLabel}" doesn't map to a role`);
      const role = roleParam ?? detectedRole;
      if (roleParam && roleParam !== detectedRole) throw new Error(`Role mismatch: "${currentLabel}" → ${detectedRole}, requested ${roleParam}`);

      // Check worker availability
      const worker = getWorker(project, role);
      if (worker.active) throw new Error(`${role.toUpperCase()} already active on ${project.name} (issue: ${worker.issueId})`);
      if ((project.roleExecution ?? "parallel") === "sequential") {
        const other = role === "dev" ? "qa" : "dev";
        if (getWorker(project, other).active) throw new Error(`Sequential roleExecution: ${other.toUpperCase()} is active`);
      }

      // Select level
      const targetLabel: StateLabel = role === "dev" ? "Doing" : "Testing";
      let selectedLevel: string, levelReason: string, levelSource: string;
      if (levelParam) {
        selectedLevel = levelParam; levelReason = "LLM-selected"; levelSource = "llm";
      } else {
        const labelLevel = detectLevelFromLabels(issue.labels);
        if (labelLevel) {
          if (role === "qa" && isDevLevel(labelLevel)) { const s = selectLevel(issue.title, issue.description ?? "", role); selectedLevel = s.level; levelReason = `QA overrides dev level "${labelLevel}"`; levelSource = "role-override"; }
          else if (role === "dev" && !isDevLevel(labelLevel)) { const s = selectLevel(issue.title, issue.description ?? "", role); selectedLevel = s.level; levelReason = s.reason; levelSource = "heuristic"; }
          else { selectedLevel = labelLevel; levelReason = `Label: "${labelLevel}"`; levelSource = "label"; }
        } else {
          const s = selectLevel(issue.title, issue.description ?? "", role);
          selectedLevel = s.level; levelReason = s.reason; levelSource = "heuristic";
        }
      }

      // Dispatch
      const pluginConfig = getPluginConfig(api);
      const dr = await dispatchTask({
        workspaceDir, agentId: ctx.agentId, groupId, project, issueId: issue.iid,
        issueTitle: issue.title, issueDescription: issue.description ?? "", issueUrl: issue.web_url,
        role, level: selectedLevel, fromLabel: currentLabel, toLabel: targetLabel,
        transitionLabel: (id, from, to) => provider.transitionLabel(id, from as StateLabel, to as StateLabel),
        pluginConfig, sessionKey: ctx.sessionKey,
      });

      // Notify
      const notifyConfig = getNotificationConfig(pluginConfig);
      await notify(
        { type: "workerStart", project: project.name, groupId, issueId: issue.iid, issueTitle: issue.title, issueUrl: issue.web_url, role, level: dr.level, sessionAction: dr.sessionAction },
        { workspaceDir, config: notifyConfig, groupId, channel: context.channel },
      );

      // Auto-tick disabled per issue #125 - work_start should only pick up the explicitly requested issue
      // To fill parallel slots, use work_heartbeat instead
      // const tickPickups = await tickAndNotify({ ... });

      const output: Record<string, unknown> = {
        success: true, project: project.name, groupId, issueId: issue.iid, issueTitle: issue.title,
        role, level: dr.level, model: dr.model, sessionAction: dr.sessionAction,
        announcement: dr.announcement, labelTransition: `${currentLabel} → ${targetLabel}`,
        levelReason, levelSource,
        autoDetected: { projectGroupId: !groupIdParam, role: !roleParam, issueId: issueIdParam === undefined, level: !levelParam },
      };
      // tickPickups removed with auto-tick

      return jsonResult(output);
    },
  });
}
