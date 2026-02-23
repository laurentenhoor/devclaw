/**
 * tick.ts — Project-level queue scan + dispatch.
 *
 * Core function: projectTick() scans one project's queue and fills free worker slots.
 * Called by: work_start (fill parallel slot), work_finish (next pipeline step), heartbeat service (sweep).
 */
import type { PluginRuntime } from "openclaw/plugin-sdk";
import type { Issue, IssueProvider } from "../providers/provider.js";
import { createProvider } from "../providers/index.js";
import { selectLevel } from "../model-selector.js";
import { getRoleWorker, getProject, readProjects, findFreeSlot, countActiveSlots, reconcileSlots } from "../projects.js";
import { dispatchTask } from "../dispatch.js";
import { getLevelsForRole } from "../roles/index.js";
import { loadConfig } from "../config/index.js";
import {
  ExecutionMode,
  ReviewPolicy,
  TestPolicy,
  getActiveLabel,
  type WorkflowConfig,
  type Role,
} from "../workflow.js";
import { detectRoleLevelFromLabels, detectStepRouting, findNextIssueForRole } from "./queue-scan.js";

// ---------------------------------------------------------------------------
// projectTick
// ---------------------------------------------------------------------------

export type TickAction = {
  project: string;
  projectSlug: string;
  issueId: number;
  issueTitle: string;
  issueUrl: string;
  role: Role;
  level: string;
  sessionAction: "spawn" | "send";
  announcement: string;
};

export type TickResult = {
  pickups: TickAction[];
  skipped: Array<{ role?: string; reason: string }>;
};

/**
 * Scan one project's queue and fill free worker slots.
 *
 * Does NOT run health checks (that's the heartbeat service's job).
 * Non-destructive: only dispatches if slots are free and issues are queued.
 */
export async function projectTick(opts: {
  workspaceDir: string;
  projectSlug: string;
  agentId?: string;
  sessionKey?: string;
  pluginConfig?: Record<string, unknown>;
  dryRun?: boolean;
  maxPickups?: number;
  /** Only attempt this role. Used by work_start to fill the other slot. */
  targetRole?: Role;
  /** Optional provider override (for testing). Uses createProvider if omitted. */
  provider?: IssueProvider;
  /** Plugin runtime for direct API access (avoids CLI subprocess timeouts) */
  runtime?: PluginRuntime;
  /** Workflow config (defaults to DEFAULT_WORKFLOW) */
  workflow?: WorkflowConfig;
  /** Instance name for ownership filtering and auto-claiming. */
  instanceName?: string;
}): Promise<TickResult> {
  const {
    workspaceDir, projectSlug, agentId, sessionKey, pluginConfig, dryRun,
    maxPickups, targetRole, runtime, instanceName,
  } = opts;

  const project = getProject(await readProjects(workspaceDir), projectSlug);
  if (!project) return { pickups: [], skipped: [{ reason: `Project not found: ${projectSlug}` }] };

  const resolvedConfig = await loadConfig(workspaceDir, project.name);
  const workflow = opts.workflow ?? resolvedConfig.workflow;

  const provider = opts.provider ?? (await createProvider({ repo: project.repo, provider: project.provider })).provider;
  const roleExecution = workflow.roleExecution ?? ExecutionMode.PARALLEL;
  const enabledRoles = Object.entries(resolvedConfig.roles)
    .filter(([, r]) => r.enabled)
    .map(([id]) => id);
  const roles: Role[] = targetRole ? [targetRole] : enabledRoles;

  const pickups: TickAction[] = [];
  const skipped: TickResult["skipped"] = [];
  let pickupCount = 0;

  for (const role of roles) {
    if (maxPickups !== undefined && pickupCount >= maxPickups) {
      skipped.push({ role, reason: "Max pickups reached" });
      continue;
    }

    // Re-read fresh state (previous dispatch may have changed it)
    const fresh = getProject(await readProjects(workspaceDir), projectSlug);
    if (!fresh) break;

    const roleWorker = getRoleWorker(fresh, role);
    const levelMaxWorkers = resolvedConfig.roles[role]?.levelMaxWorkers ?? {};
    reconcileSlots(roleWorker, levelMaxWorkers);

    // Check sequential role execution: any other role must be inactive
    const otherRoles = enabledRoles.filter((r: string) => r !== role);
    if (roleExecution === ExecutionMode.SEQUENTIAL && otherRoles.some((r: string) => countActiveSlots(getRoleWorker(fresh, r)) > 0)) {
      skipped.push({ role, reason: "Sequential: other role active" });
      continue;
    }

    // Review policy gate: fallback for issues dispatched before step routing labels existed
    if (role === "reviewer") {
      const policy = workflow.reviewPolicy ?? ReviewPolicy.HUMAN;
      if (policy === ReviewPolicy.HUMAN) {
        skipped.push({ role, reason: "Review policy: human (heartbeat handles via PR polling)" });
        continue;
      }
      if (policy === ReviewPolicy.SKIP) {
        skipped.push({ role, reason: "Review policy: skip (heartbeat handles via review-skip pass)" });
        continue;
      }
    }

    // Test policy gate: fallback for issues dispatched before test routing labels existed
    if (role === "tester") {
      const policy = workflow.testPolicy ?? TestPolicy.SKIP;
      if (policy === TestPolicy.SKIP) {
        skipped.push({ role, reason: "Test policy: skip (heartbeat handles via test-skip pass)" });
        continue;
      }
    }

    const next = await findNextIssueForRole(provider, role, workflow, instanceName);
    if (!next) continue;

    const { issue, label: currentLabel } = next;
    const targetLabel = getActiveLabel(workflow, role);

    // Step routing: check for review:human / review:skip / test:skip labels
    if (role === "reviewer") {
      const routing = detectStepRouting(issue.labels, "review");
      if (routing === "human" || routing === "skip") {
        skipped.push({ role, reason: `review:${routing} label` });
        continue;
      }
    }
    if (role === "tester") {
      const routing = detectStepRouting(issue.labels, "test");
      if (routing === "skip") {
        skipped.push({ role, reason: "test:skip label" });
        continue;
      }
    }

    // Level selection: label → heuristic (must happen before free slot check)
    const selectedLevel = resolveLevelForIssue(issue, role);

    // Check per-level slot availability
    const freeSlot = findFreeSlot(roleWorker, selectedLevel);
    if (freeSlot === null) {
      skipped.push({ role, reason: `${selectedLevel} slots full` });
      continue;
    }

    if (dryRun) {
      const existingSession = roleWorker.levels[selectedLevel]?.[freeSlot]?.sessionKey;
      pickups.push({
        project: project.name, projectSlug, issueId: issue.iid, issueTitle: issue.title, issueUrl: issue.web_url,
        role, level: selectedLevel,
        sessionAction: existingSession ? "send" : "spawn",
        announcement: `[DRY RUN] Would pick up #${issue.iid}`,
      });
    } else {
      try {
        const dr = await dispatchTask({
          workspaceDir, agentId, project: fresh, issueId: issue.iid,
          issueTitle: issue.title, issueDescription: issue.description ?? "", issueUrl: issue.web_url,
          role, level: selectedLevel, fromLabel: currentLabel, toLabel: targetLabel,
          provider,
          pluginConfig,
          sessionKey,
          runtime,
          slotIndex: freeSlot,
          instanceName,
        });
        pickups.push({
          project: project.name, projectSlug, issueId: issue.iid, issueTitle: issue.title, issueUrl: issue.web_url,
          role, level: dr.level, sessionAction: dr.sessionAction, announcement: dr.announcement,
        });
      } catch (err) {
        skipped.push({ role, reason: `Dispatch failed: ${(err as Error).message}` });
        continue;
      }
    }
    pickupCount++;
  }

  return { pickups, skipped };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Determine the level for an issue based on labels and heuristic fallback.
 *
 * Priority:
 * 1. This role's own label (e.g. tester:medior from a previous dispatch)
 * 2. Inherit from another role's label (e.g. developer:medior → tester uses medior)
 * 3. Heuristic fallback (first dispatch, no labels yet)
 */
function resolveLevelForIssue(issue: Issue, role: Role): string {
  const roleLevel = detectRoleLevelFromLabels(issue.labels);

  // Own role label
  if (roleLevel?.role === role) return roleLevel.level;

  // Inherit from another role's label if level is valid for this role
  if (roleLevel) {
    const levels = getLevelsForRole(role);
    if (levels.includes(roleLevel.level)) return roleLevel.level;
  }

  // Heuristic fallback
  return selectLevel(issue.title, issue.description ?? "", role).level;
}
