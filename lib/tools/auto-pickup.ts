/**
 * auto_pickup — Automated task pickup (heartbeat handler).
 *
 * Health checks → projectTick per project → notify.
 * Optional projectGroupId for single-project or all-project sweep.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../types.js";
import { readProjects } from "../projects.js";
import { log as auditLog } from "../audit.js";
import { notify, getNotificationConfig } from "../notify.js";
import { checkWorkerHealth, type HealthFix } from "../services/health.js";
import { projectTick, type TickAction } from "../services/tick.js";
import { requireWorkspaceDir, resolveContext, resolveProvider, getPluginConfig } from "../tool-helpers.js";

type ExecutionMode = "parallel" | "sequential";

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
      const workspaceDir = requireWorkspaceDir(ctx);

      const pluginConfig = getPluginConfig(api);
      const projectExecution: ExecutionMode = (pluginConfig?.projectExecution as ExecutionMode) ?? "parallel";

      const data = await readProjects(workspaceDir);
      const projectEntries = targetGroupId
        ? [[targetGroupId, data.projects[targetGroupId]] as const].filter(([, p]) => p)
        : Object.entries(data.projects);

      if (projectEntries.length === 0) {
        return jsonResult({ success: true, dryRun, healthFixes: [], pickups: [], skipped: [{ project: "(none)", reason: "No projects" }] });
      }

      const healthFixes: Array<HealthFix & { project: string; role: string }> = [];
      const pickups: Array<TickAction & { project: string }> = [];
      const skipped: Array<{ project: string; role?: string; reason: string }> = [];
      let globalActiveDev = 0, globalActiveQa = 0, activeProjectCount = 0, pickupCount = 0;

      // Pass 1: health checks
      for (const [groupId, project] of projectEntries) {
        const { provider } = resolveProvider(project);
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

      // Pass 2: projectTick per project
      for (const [groupId] of projectEntries) {
        const current = (await readProjects(workspaceDir)).projects[groupId];
        if (!current) continue;
        const projectActive = current.dev.active || current.qa.active;

        // Sequential project guard (needs global state)
        if (projectExecution === "sequential" && !projectActive && activeProjectCount >= 1) {
          skipped.push({ project: current.name, reason: "Sequential: another project active" });
          continue;
        }

        const remaining = maxPickups !== undefined ? maxPickups - pickupCount : undefined;
        const result = await projectTick({
          workspaceDir, groupId, agentId: ctx.agentId, pluginConfig, sessionKey: ctx.sessionKey,
          dryRun, maxPickups: remaining,
        });

        pickups.push(...result.pickups.map((p) => ({ ...p, project: current.name })));
        skipped.push(...result.skipped.map((s) => ({ project: current.name, ...s })));
        pickupCount += result.pickups.length;
        for (const p of result.pickups) {
          if (p.role === "dev") globalActiveDev++; else globalActiveQa++;
        }
        if (result.pickups.length > 0 && !projectActive) activeProjectCount++;
      }

      await auditLog(workspaceDir, "auto_pickup", {
        dryRun, projectExecution, projectsScanned: projectEntries.length,
        healthFixes: healthFixes.length, pickups: pickups.length, skipped: skipped.length,
      });

      // Notify
      const context = await resolveContext(ctx, api);
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
