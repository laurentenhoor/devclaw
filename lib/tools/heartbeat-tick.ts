/**
 * heartbeat_tick — Automated task pickup across all projects.
 *
 * Runs on heartbeat/cron context:
 * 1. Clean zombie sessions (session_health logic)
 * 2. Loop over all projects
 * 3. Check worker slots per project
 * 4. Pick up tasks by priority (To Improve > To Test > To Do)
 * 5. Respect two-level work mode:
 *    - projectExecution (plugin-level): parallel/sequential for projects
 *    - roleExecution (project-level): parallel/sequential for roles within a project
 * 6. Return summary of actions taken
 *
 * Context guard: Only allows from DM/cron context, blocks project groups.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import { dispatchTask } from "../dispatch.js";
import { type Issue, type StateLabel } from "../task-managers/task-manager.js";
import { createProvider } from "../task-managers/index.js";
import { selectModel } from "../model-selector.js";
import {
  getProject,
  getWorker,
  getSessionForModel,
  readProjects,
  updateWorker,
  type Project,
} from "../projects.js";
import type { ToolContext } from "../types.js";
import { detectContext, generateGuardrails } from "../context-guard.js";
import { type Tier } from "../tiers.js";
import { log as auditLog } from "../audit.js";
import { notify, getNotificationConfig } from "../notify.js";

/** Labels that map to DEV role */
const DEV_LABELS: StateLabel[] = ["To Do", "To Improve"];

/** Labels that map to QA role */
const QA_LABELS: StateLabel[] = ["To Test"];

/** All pickable labels, in priority order (highest first) */
const PRIORITY_ORDER: StateLabel[] = ["To Improve", "To Test", "To Do"];

/** Tier labels that can appear on issues */
const TIER_LABELS: Tier[] = ["junior", "medior", "senior", "qa"];

type ExecutionMode = "parallel" | "sequential";

type PickupAction = {
  project: string;
  groupId: string;
  issueId: number;
  issueTitle: string;
  role: "dev" | "qa";
  model: string;
  sessionAction: "spawn" | "send";
  announcement: string;
};

type HealthFix = {
  project: string;
  role: "dev" | "qa";
  type: string;
  fixed: boolean;
};

type TickResult = {
  success: boolean;
  dryRun: boolean;
  projectExecution: ExecutionMode;
  healthFixes: HealthFix[];
  pickups: PickupAction[];
  skipped: Array<{ project: string; role?: "dev" | "qa"; reason: string }>;
  globalState?: { activeProjects: number; activeDev: number; activeQa: number };
};

/**
 * Detect role from issue's current state label.
 */
function detectRoleFromLabel(label: StateLabel): "dev" | "qa" | null {
  if (DEV_LABELS.includes(label)) return "dev";
  if (QA_LABELS.includes(label)) return "qa";
  return null;
}

/**
 * Detect tier from issue labels (e.g., "junior", "senior").
 */
function detectTierFromLabels(labels: string[]): Tier | null {
  const lowerLabels = labels.map((l) => l.toLowerCase());
  for (const tier of TIER_LABELS) {
    if (lowerLabels.includes(tier)) {
      return tier;
    }
  }
  return null;
}

/**
 * Find the next issue to pick up by priority for a specific role.
 */
async function findNextIssueForRole(
  provider: { listIssuesByLabel(label: StateLabel): Promise<Issue[]> },
  role: "dev" | "qa",
): Promise<{ issue: Issue; label: StateLabel } | null> {
  const labelsToCheck =
    role === "dev"
      ? PRIORITY_ORDER.filter((l) => DEV_LABELS.includes(l))
      : PRIORITY_ORDER.filter((l) => QA_LABELS.includes(l));

  for (const label of labelsToCheck) {
    try {
      const issues = await provider.listIssuesByLabel(label);
      if (issues.length > 0) {
        // Return oldest issue first (FIFO)
        const oldest = issues[issues.length - 1];
        return { issue: oldest, label };
      }
    } catch {
      // Continue to next label on error
    }
  }
  return null;
}

/**
 * Run health check logic for a single project/role.
 * Returns fixes applied (simplified version of session_health).
 */
async function checkAndFixWorkerHealth(
  workspaceDir: string,
  groupId: string,
  project: Project,
  role: "dev" | "qa",
  activeSessions: string[],
  autoFix: boolean,
  provider: { transitionLabel(id: number, from: StateLabel, to: StateLabel): Promise<void> },
): Promise<HealthFix[]> {
  const fixes: HealthFix[] = [];
  const worker = project[role];
  const currentSessionKey = worker.model
    ? getSessionForModel(worker, worker.model)
    : null;

  // Check 1: Active but no session key for current model
  if (worker.active && !currentSessionKey) {
    if (autoFix) {
      await updateWorker(workspaceDir, groupId, role, {
        active: false,
        issueId: null,
      });
    }
    fixes.push({
      project: project.name,
      role,
      type: "active_no_session",
      fixed: autoFix,
    });
  }

  // Check 2: Active with session but session is dead (zombie)
  if (
    worker.active &&
    currentSessionKey &&
    activeSessions.length > 0 &&
    !activeSessions.includes(currentSessionKey)
  ) {
    if (autoFix) {
      // Revert issue label
      const revertLabel: StateLabel = role === "dev" ? "To Do" : "To Test";
      const currentLabel: StateLabel = role === "dev" ? "Doing" : "Testing";
      try {
        if (worker.issueId) {
          const primaryIssueId = Number(worker.issueId.split(",")[0]);
          await provider.transitionLabel(primaryIssueId, currentLabel, revertLabel);
        }
      } catch {
        // Best-effort label revert
      }

      // Clear the dead session
      const updatedSessions = { ...worker.sessions };
      if (worker.model) {
        updatedSessions[worker.model] = null;
      }

      await updateWorker(workspaceDir, groupId, role, {
        active: false,
        issueId: null,
        sessions: updatedSessions,
      });
    }
    fixes.push({
      project: project.name,
      role,
      type: "zombie_session",
      fixed: autoFix,
    });
  }

  // Check 3: Inactive but still has issueId
  if (!worker.active && worker.issueId) {
    if (autoFix) {
      await updateWorker(workspaceDir, groupId, role, {
        issueId: null,
      });
    }
    fixes.push({
      project: project.name,
      role,
      type: "inactive_with_issue",
      fixed: autoFix,
    });
  }

  return fixes;
}

/**
 * Get max workers for a role from project config (with defaults).
 */
function getMaxWorkers(project: Project, role: "dev" | "qa"): number {
  const key = role === "dev" ? "maxDevWorkers" : "maxQaWorkers";
  const value = (project as Record<string, unknown>)[key];
  return typeof value === "number" ? value : 1;
}

export function createHeartbeatTickTool(api: OpenClawPluginApi) {
  return (ctx: ToolContext) => ({
    name: "heartbeat_tick",
    label: "Heartbeat Tick",
    description: `Automated task pickup across all projects. Runs session health checks, then picks up tasks by priority (To Improve > To Test > To Do). Respects two-level work mode: plugin-level projectExecution (parallel/sequential for projects) and project-level roleExecution (parallel/sequential for roles within a project). Only works from DM/cron context, not project groups.`,
    parameters: {
      type: "object",
      properties: {
        dryRun: {
          type: "boolean",
          description: "Report what would happen without actually picking up tasks. Default: false.",
        },
        maxPickups: {
          type: "number",
          description: "Maximum number of task pickups per tick. Default: unlimited.",
        },
        activeSessions: {
          type: "array",
          items: { type: "string" },
          description: "List of currently alive session IDs from sessions_list. Used for zombie detection.",
        },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const dryRun = (params.dryRun as boolean) ?? false;
      const maxPickups = params.maxPickups as number | undefined;
      const activeSessions = (params.activeSessions as string[]) ?? [];
      const workspaceDir = ctx.workspaceDir;

      if (!workspaceDir) {
        throw new Error("No workspace directory available in tool context");
      }

      // --- Context detection ---
      const devClawAgentIds =
        ((api.pluginConfig as Record<string, unknown>)?.devClawAgentIds as
          | string[]
          | undefined) ?? [];
      const context = await detectContext(ctx, devClawAgentIds);

      // Only allow from DM or direct context (not project groups)
      if (context.type === "group") {
        return jsonResult({
          success: false,
          error: "heartbeat_tick cannot be used in project group chats.",
          recommendation: "Use this tool from a DM or cron context to manage all projects.",
          contextGuidance: generateGuardrails(context),
        });
      }

      // Get plugin-level projectExecution mode from plugin config
      const pluginConfig = api.pluginConfig as Record<string, unknown> | undefined;
      const projectExecution: ExecutionMode =
        (pluginConfig?.projectExecution as ExecutionMode) ?? "parallel";

      const result: TickResult = {
        success: true,
        dryRun,
        projectExecution,
        healthFixes: [],
        pickups: [],
        skipped: [],
      };

      // Read all projects
      const data = await readProjects(workspaceDir);
      const projectEntries = Object.entries(data.projects);

      if (projectEntries.length === 0) {
        return jsonResult({
          ...result,
          skipped: [{ project: "(none)", reason: "No projects registered" }],
        });
      }

      // Track global worker counts for sequential mode
      let globalActiveDev = 0;
      let globalActiveQa = 0;
      let activeProjectCount = 0;
      let pickupCount = 0;

      // First pass: count active workers and run health checks
      for (const [groupId, project] of projectEntries) {
        const { provider } = createProvider({ repo: project.repo });

        // Health check for both roles
        for (const role of ["dev", "qa"] as const) {
          const fixes = await checkAndFixWorkerHealth(
            workspaceDir,
            groupId,
            project,
            role,
            activeSessions,
            !dryRun, // autoFix when not dryRun
            provider,
          );
          result.healthFixes.push(...fixes);
        }

        // Re-read project after health fixes
        const refreshedData = await readProjects(workspaceDir);
        const refreshedProject = refreshedData.projects[groupId];
        if (refreshedProject) {
          const devActive = refreshedProject.dev.active;
          const qaActive = refreshedProject.qa.active;
          if (devActive) globalActiveDev++;
          if (qaActive) globalActiveQa++;
          if (devActive || qaActive) activeProjectCount++;
        }
      }

      // Second pass: pick up tasks
      for (const [groupId, _project] of projectEntries) {
        // Re-read to get post-health-fix state
        const currentData = await readProjects(workspaceDir);
        const project = currentData.projects[groupId];
        if (!project) continue;

        const { provider } = createProvider({ repo: project.repo });

        // Get project-level roleExecution mode (default: parallel)
        const roleExecution: ExecutionMode = project.roleExecution ?? "parallel";

        // Check if this project has any active workers
        const projectHasActiveWorker = project.dev.active || project.qa.active;

        // Plugin-level projectExecution check: if sequential, only one project can have workers
        if (projectExecution === "sequential" && !projectHasActiveWorker && activeProjectCount >= 1) {
          result.skipped.push({
            project: project.name,
            reason: "Sequential projectExecution: another project has active workers",
          });
          continue;
        }

        // Check each role
        for (const role of ["dev", "qa"] as const) {
          // Check max pickups limit
          if (maxPickups !== undefined && pickupCount >= maxPickups) {
            result.skipped.push({
              project: project.name,
              role,
              reason: `Max pickups (${maxPickups}) reached`,
            });
            continue;
          }

          // Check if worker slot is available
          const worker = getWorker(project, role);
          if (worker.active) {
            result.skipped.push({
              project: project.name,
              role,
              reason: `${role.toUpperCase()} already active (issue #${worker.issueId})`,
            });
            continue;
          }

          // Check max workers per project
          const maxWorkers = getMaxWorkers(project, role);
          // For now we only support 1 worker per role, but structure supports more
          if (maxWorkers < 1) {
            result.skipped.push({
              project: project.name,
              role,
              reason: `${role.toUpperCase()} disabled (maxWorkers=0)`,
            });
            continue;
          }

          // Project-level roleExecution check: if sequential, only one role can be active
          if (roleExecution === "sequential") {
            const otherRole = role === "dev" ? "qa" : "dev";
            const otherWorker = getWorker(project, otherRole);
            if (otherWorker.active) {
              result.skipped.push({
                project: project.name,
                role,
                reason: `Sequential roleExecution: ${otherRole.toUpperCase()} already active`,
              });
              continue;
            }
          }

          // Find next issue for this role
          const next = await findNextIssueForRole(provider, role);
          if (!next) {
            // No tasks available - not a skip, just nothing to do
            continue;
          }

          const { issue, label: currentLabel } = next;
          const targetLabel: StateLabel = role === "dev" ? "Doing" : "Testing";

          // Select model
          let modelAlias: string;
          const tierFromLabels = detectTierFromLabels(issue.labels);

          if (tierFromLabels) {
            // Validate tier matches role
            if (role === "qa" && tierFromLabels !== "qa") {
              modelAlias = "qa";
            } else if (role === "dev" && tierFromLabels === "qa") {
              const selected = selectModel(issue.title, issue.description ?? "", role);
              modelAlias = selected.tier;
            } else {
              modelAlias = tierFromLabels;
            }
          } else {
            const selected = selectModel(issue.title, issue.description ?? "", role);
            modelAlias = selected.tier;
          }

          if (dryRun) {
            // In dry run, just report what would happen
            result.pickups.push({
              project: project.name,
              groupId,
              issueId: issue.iid,
              issueTitle: issue.title,
              role,
              model: modelAlias,
              sessionAction: getSessionForModel(worker, modelAlias) ? "send" : "spawn",
              announcement: `[DRY RUN] Would pick up #${issue.iid}: ${issue.title}`,
            });
            pickupCount++;
            if (role === "dev") globalActiveDev++;
            if (role === "qa") globalActiveQa++;
            if (!projectHasActiveWorker) activeProjectCount++;
          } else {
            // Actually dispatch
            try {
              const dispatchResult = await dispatchTask({
                workspaceDir,
                agentId: ctx.agentId,
                groupId,
                project,
                issueId: issue.iid,
                issueTitle: issue.title,
                issueDescription: issue.description ?? "",
                issueUrl: issue.web_url,
                role,
                modelAlias,
                fromLabel: currentLabel,
                toLabel: targetLabel,
                transitionLabel: (id, from, to) =>
                  provider.transitionLabel(id, from as StateLabel, to as StateLabel),
                pluginConfig,
              });

              result.pickups.push({
                project: project.name,
                groupId,
                issueId: issue.iid,
                issueTitle: issue.title,
                role,
                model: dispatchResult.modelAlias,
                sessionAction: dispatchResult.sessionAction,
                announcement: dispatchResult.announcement,
              });
              pickupCount++;
              if (role === "dev") globalActiveDev++;
              if (role === "qa") globalActiveQa++;
              if (!projectHasActiveWorker) activeProjectCount++;
            } catch (err) {
              result.skipped.push({
                project: project.name,
                role,
                reason: `Dispatch failed for #${issue.iid}: ${(err as Error).message}`,
              });
            }
          }
        }
      }

      // Add global state for visibility
      result.globalState = {
        activeProjects: activeProjectCount,
        activeDev: globalActiveDev,
        activeQa: globalActiveQa,
      };

      // Audit log
      await auditLog(workspaceDir, "heartbeat_tick", {
        dryRun,
        projectExecution,
        projectsScanned: projectEntries.length,
        healthFixes: result.healthFixes.length,
        pickups: result.pickups.length,
        skipped: result.skipped.length,
      });

      // Send heartbeat notification to orchestrator DM
      const notifyConfig = getNotificationConfig(pluginConfig);
      const orchestratorDm = pluginConfig?.orchestratorDm as string | undefined;
      
      await notify(
        {
          type: "heartbeat",
          projectsScanned: projectEntries.length,
          healthFixes: result.healthFixes.length,
          pickups: result.pickups.length,
          skipped: result.skipped.length,
          dryRun,
          pickupDetails: result.pickups.map((p) => ({
            project: p.project,
            issueId: p.issueId,
            role: p.role,
          })),
        },
        {
          workspaceDir,
          config: notifyConfig,
          orchestratorDm,
          channel: "telegram",
        },
      );

      return jsonResult(result);
    },
  });
}
