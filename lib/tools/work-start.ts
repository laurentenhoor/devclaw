/**
 * work_start — Pick up a task from the issue queue.
 *
 * Context-aware: ONLY works in project group chats.
 * Auto-detects: projectGroupId, role, model, issueId.
 * After dispatch, ticks the project queue to fill parallel slots.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../types.js";
import type { StateLabel } from "../providers/provider.js";
import { createProvider } from "../providers/index.js";
import { selectModel } from "../model-selector.js";
import { activateWorker, getProject, getWorker, readProjects } from "../projects.js";
import { dispatchTask } from "../dispatch.js";
import { detectContext, generateGuardrails } from "../context-guard.js";
import { notify, getNotificationConfig } from "../notify.js";
import { findNextIssue, detectRoleFromLabel, detectTierFromLabels, projectTick, type TickResult } from "../services/tick.js";

export function createWorkStartTool(api: OpenClawPluginApi) {
  return (ctx: ToolContext) => ({
    name: "work_start",
    label: "Work Start",
    description: `Pick up a task from the issue queue. ONLY works in project group chats. Handles label transition, tier assignment, session creation, dispatch, audit, and ticks the queue to fill parallel slots.`,
    parameters: {
      type: "object",
      properties: {
        issueId: { type: "number", description: "Issue ID. If omitted, picks next by priority." },
        role: { type: "string", enum: ["dev", "qa"], description: "Worker role. Auto-detected from label if omitted." },
        projectGroupId: { type: "string", description: "Project group ID. Auto-detected from group context." },
        model: { type: "string", description: "Developer tier (junior/medior/senior/qa). Auto-detected if omitted." },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const issueIdParam = params.issueId as number | undefined;
      const roleParam = params.role as "dev" | "qa" | undefined;
      const groupIdParam = params.projectGroupId as string | undefined;
      const modelParam = params.model as string | undefined;
      const workspaceDir = ctx.workspaceDir;
      if (!workspaceDir) throw new Error("No workspace directory available");

      // Context guard: group only
      const devClawAgentIds = ((api.pluginConfig as Record<string, unknown>)?.devClawAgentIds as string[] | undefined) ?? [];
      const context = await detectContext(ctx, devClawAgentIds);
      if (context.type !== "group") {
        return jsonResult({
          success: false,
          error: "work_start can only be used in project group chats.",
          recommendation: context.type === "via-agent" ? "Use onboard instead for setup." : "Use the relevant project group.",
          contextGuidance: generateGuardrails(context),
        });
      }

      const groupId = groupIdParam ?? context.groupId;
      const data = await readProjects(workspaceDir);
      const project = getProject(data, groupId);
      if (!project) throw new Error(`Project not found for groupId: ${groupId}`);

      const { provider } = createProvider({ repo: project.repo });

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

      // Select model
      const targetLabel: StateLabel = role === "dev" ? "Doing" : "Testing";
      let modelAlias: string, modelReason: string, modelSource: string;
      if (modelParam) {
        modelAlias = modelParam; modelReason = "LLM-selected"; modelSource = "llm";
      } else {
        const tier = detectTierFromLabels(issue.labels);
        if (tier) {
          if (role === "qa" && tier !== "qa") { modelAlias = "qa"; modelReason = `QA overrides "${tier}"`; modelSource = "role-override"; }
          else if (role === "dev" && tier === "qa") { const s = selectModel(issue.title, issue.description ?? "", role); modelAlias = s.tier; modelReason = s.reason; modelSource = "heuristic"; }
          else { modelAlias = tier; modelReason = `Label: "${tier}"`; modelSource = "label"; }
        } else {
          const s = selectModel(issue.title, issue.description ?? "", role);
          modelAlias = s.tier; modelReason = s.reason; modelSource = "heuristic";
        }
      }

      // Dispatch
      const pluginConfig = api.pluginConfig as Record<string, unknown> | undefined;
      const dr = await dispatchTask({
        workspaceDir, agentId: ctx.agentId, groupId, project, issueId: issue.iid,
        issueTitle: issue.title, issueDescription: issue.description ?? "", issueUrl: issue.web_url,
        role, modelAlias, fromLabel: currentLabel, toLabel: targetLabel,
        transitionLabel: (id, from, to) => provider.transitionLabel(id, from as StateLabel, to as StateLabel),
        pluginConfig, sessionKey: ctx.sessionKey,
      });

      // Ensure worker state
      const stateUpdate: { issueId: string; model: string; sessionKey?: string; startTime?: string } = {
        issueId: String(issue.iid), model: modelAlias,
      };
      if (dr.sessionAction === "spawn") {
        stateUpdate.sessionKey = dr.sessionKey;
        stateUpdate.startTime = new Date().toISOString();
      }
      await activateWorker(workspaceDir, groupId, role, stateUpdate);

      // Notify
      const notifyConfig = getNotificationConfig(pluginConfig);
      await notify(
        { type: "workerStart", project: project.name, groupId, issueId: issue.iid, issueTitle: issue.title, issueUrl: issue.web_url, role, model: dr.modelAlias, sessionAction: dr.sessionAction },
        { workspaceDir, config: notifyConfig, groupId, channel: context.channel },
      );

      // Tick: fill parallel slots
      let tickResult: TickResult | null = null;
      try {
        tickResult = await projectTick({
          workspaceDir, groupId, agentId: ctx.agentId, pluginConfig, sessionKey: ctx.sessionKey,
          targetRole: role === "dev" ? "qa" : "dev",
        });
      } catch { /* non-fatal */ }

      const output: Record<string, unknown> = {
        success: true, project: project.name, groupId, issueId: issue.iid, issueTitle: issue.title,
        role, model: dr.modelAlias, fullModel: dr.fullModel, sessionAction: dr.sessionAction,
        announcement: dr.announcement, labelTransition: `${currentLabel} → ${targetLabel}`,
        modelReason, modelSource,
        autoDetected: { projectGroupId: !groupIdParam, role: !roleParam, issueId: issueIdParam === undefined, model: !modelParam },
      };
      if (tickResult?.pickups.length) output.tickPickups = tickResult.pickups;

      return jsonResult(output);
    },
  });
}
