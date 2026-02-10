/**
 * auto_pickup — Automated task pickup (heartbeat handler).
 *
 * Health checks → queue scan → fill free worker slots.
 * Optional projectGroupId for single-project or all-project sweep.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../types.js";
import type { Issue, StateLabel } from "../providers/provider.js";
import { createProvider } from "../providers/index.js";
import { selectModel } from "../model-selector.js";
import { getProject, getWorker, getSessionForModel, readProjects, type Project } from "../projects.js";
import { dispatchTask } from "../dispatch.js";
import { detectContext, generateGuardrails } from "../context-guard.js";
import { type Tier } from "../tiers.js";
import { log as auditLog } from "../audit.js";
import { notify, getNotificationConfig } from "../notify.js";
import { checkWorkerHealth, type HealthFix } from "../services/health.js";

const DEV_LABELS: StateLabel[] = ["To Do", "To Improve"];
const QA_LABELS: StateLabel[] = ["To Test"];
const PRIORITY_ORDER: StateLabel[] = ["To Improve", "To Test", "To Do"];
const TIER_LABELS: Tier[] = ["junior", "medior", "senior", "qa"];

type ExecutionMode = "parallel" | "sequential";
type PickupAction = { project: string; groupId: string; issueId: number; issueTitle: string; role: "dev" | "qa"; model: string; sessionAction: "spawn" | "send"; announcement: string };

function detectTierFromLabels(labels: string[]): Tier | null {
  const lower = labels.map((l) => l.toLowerCase());
  return TIER_LABELS.find((t) => lower.includes(t)) ?? null;
}

async function findNextIssueForRole(
  provider: { listIssuesByLabel(label: StateLabel): Promise<Issue[]> },
  role: "dev" | "qa",
): Promise<{ issue: Issue; label: StateLabel } | null> {
  const labels = role === "dev"
    ? PRIORITY_ORDER.filter((l) => DEV_LABELS.includes(l))
    : PRIORITY_ORDER.filter((l) => QA_LABELS.includes(l));
  for (const label of labels) {
    try {
      const issues = await provider.listIssuesByLabel(label);
      if (issues.length > 0) return { issue: issues[issues.length - 1], label };
    } catch { /* continue */ }
  }
  return null;
}

export function createAutoPickupTool(api: OpenClawPluginApi) {
  return (ctx: ToolContext) => ({
    name: "auto_pickup",
    label: "Auto Pickup",
    description: `Automated task pickup. With projectGroupId: targets one project. Without: sweeps all projects. Runs health checks, then fills free worker slots by priority.`,
    parameters: {
      type: "object",
      properties: {
        projectGroupId: { type: "string", description: "Target a single project. Omit to sweep all." },
        dryRun: { type: "boolean", description: "Report only, don't dispatch. Default: false." },
        maxPickups: { type: "number", description: "Max pickups per tick." },
        activeSessions: { type: "array", items: { type: "string" }, description: "Active session IDs for zombie detection." },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const targetGroupId = params.projectGroupId as string | undefined;
      const dryRun = (params.dryRun as boolean) ?? false;
      const maxPickups = params.maxPickups as number | undefined;
      const activeSessions = (params.activeSessions as string[]) ?? [];
      const workspaceDir = ctx.workspaceDir;
      if (!workspaceDir) throw new Error("No workspace directory available");

      const pluginConfig = api.pluginConfig as Record<string, unknown> | undefined;
      const projectExecution: ExecutionMode = (pluginConfig?.projectExecution as ExecutionMode) ?? "parallel";

      const data = await readProjects(workspaceDir);
      const projectEntries = targetGroupId
        ? [[targetGroupId, data.projects[targetGroupId]] as const].filter(([, p]) => p)
        : Object.entries(data.projects);

      if (projectEntries.length === 0) {
        return jsonResult({ success: true, dryRun, healthFixes: [], pickups: [], skipped: [{ project: "(none)", reason: "No projects" }] });
      }

      const healthFixes: Array<HealthFix & { project: string; role: string }> = [];
      const pickups: PickupAction[] = [];
      const skipped: Array<{ project: string; role?: string; reason: string }> = [];
      let globalActiveDev = 0, globalActiveQa = 0, activeProjectCount = 0, pickupCount = 0;

      // Pass 1: health checks
      for (const [groupId, project] of projectEntries) {
        const { provider } = createProvider({ repo: project.repo });
        for (const role of ["dev", "qa"] as const) {
          const fixes = await checkWorkerHealth({ workspaceDir, groupId, project, role, activeSessions, autoFix: !dryRun, provider });
          healthFixes.push(...fixes.map((f) => ({ ...f, project: project.name, role })));
        }
        const refreshed = (await readProjects(workspaceDir)).projects[groupId];
        if (refreshed) {
          if (refreshed.dev.active) globalActiveDev++;
          if (refreshed.qa.active) globalActiveQa++;
          if (refreshed.dev.active || refreshed.qa.active) activeProjectCount++;
        }
      }

      // Pass 2: pick up tasks
      for (const [groupId] of projectEntries) {
        const current = (await readProjects(workspaceDir)).projects[groupId];
        if (!current) continue;
        const { provider } = createProvider({ repo: current.repo });
        const roleExecution: ExecutionMode = current.roleExecution ?? "parallel";
        const projectActive = current.dev.active || current.qa.active;

        if (projectExecution === "sequential" && !projectActive && activeProjectCount >= 1) {
          skipped.push({ project: current.name, reason: "Sequential: another project active" });
          continue;
        }

        for (const role of ["dev", "qa"] as const) {
          if (maxPickups !== undefined && pickupCount >= maxPickups) { skipped.push({ project: current.name, role, reason: `Max pickups reached` }); continue; }
          const worker = getWorker(current, role);
          if (worker.active) { skipped.push({ project: current.name, role, reason: `Already active (#${worker.issueId})` }); continue; }
          if (roleExecution === "sequential" && getWorker(current, role === "dev" ? "qa" : "dev").active) {
            skipped.push({ project: current.name, role, reason: `Sequential: other role active` }); continue;
          }

          const next = await findNextIssueForRole(provider, role);
          if (!next) continue;

          const { issue, label: currentLabel } = next;
          const targetLabel: StateLabel = role === "dev" ? "Doing" : "Testing";

          // Model selection
          let modelAlias: string;
          const tier = detectTierFromLabels(issue.labels);
          if (tier) {
            if (role === "qa" && tier !== "qa") modelAlias = "qa";
            else if (role === "dev" && tier === "qa") modelAlias = selectModel(issue.title, issue.description ?? "", role).tier;
            else modelAlias = tier;
          } else {
            modelAlias = selectModel(issue.title, issue.description ?? "", role).tier;
          }

          if (dryRun) {
            pickups.push({ project: current.name, groupId, issueId: issue.iid, issueTitle: issue.title, role, model: modelAlias, sessionAction: getSessionForModel(worker, modelAlias) ? "send" : "spawn", announcement: `[DRY RUN] Would pick up #${issue.iid}` });
          } else {
            try {
              const dr = await dispatchTask({
                workspaceDir, agentId: ctx.agentId, groupId, project: current, issueId: issue.iid,
                issueTitle: issue.title, issueDescription: issue.description ?? "", issueUrl: issue.web_url,
                role, modelAlias, fromLabel: currentLabel, toLabel: targetLabel,
                transitionLabel: (id, from, to) => provider.transitionLabel(id, from as StateLabel, to as StateLabel),
                pluginConfig, sessionKey: ctx.sessionKey,
              });
              pickups.push({ project: current.name, groupId, issueId: issue.iid, issueTitle: issue.title, role, model: dr.modelAlias, sessionAction: dr.sessionAction, announcement: dr.announcement });
            } catch (err) {
              skipped.push({ project: current.name, role, reason: `Dispatch failed: ${(err as Error).message}` });
              continue;
            }
          }
          pickupCount++;
          if (role === "dev") globalActiveDev++; else globalActiveQa++;
          if (!projectActive) activeProjectCount++;
        }
      }

      await auditLog(workspaceDir, "auto_pickup", {
        dryRun, projectExecution, projectsScanned: projectEntries.length,
        healthFixes: healthFixes.length, pickups: pickups.length, skipped: skipped.length,
      });

      // Notify
      const devClawAgentIds = ((api.pluginConfig as Record<string, unknown>)?.devClawAgentIds as string[] | undefined) ?? [];
      const context = await detectContext(ctx, devClawAgentIds);
      const notifyConfig = getNotificationConfig(pluginConfig);
      await notify(
        { type: "heartbeat", projectsScanned: projectEntries.length, healthFixes: healthFixes.length, pickups: pickups.length, skipped: skipped.length, dryRun, pickupDetails: pickups.map((p) => ({ project: p.project, issueId: p.issueId, role: p.role })) },
        { workspaceDir, config: notifyConfig, orchestratorDm: context.type === "direct" ? context.chatId : undefined, channel: "channel" in context ? context.channel : undefined },
      );

      return jsonResult({
        success: true, dryRun, projectExecution, healthFixes, pickups, skipped,
        globalState: { activeProjects: activeProjectCount, activeDev: globalActiveDev, activeQa: globalActiveQa },
      });
    },
  });
}
