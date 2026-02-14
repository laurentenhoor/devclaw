/**
 * tick.ts — Project-level queue scan + dispatch.
 *
 * Core function: projectTick() scans one project's queue and fills free worker slots.
 * Called by: work_start (fill parallel slot), work_finish (next pipeline step), heartbeat service (sweep).
 */
import type { PluginRuntime } from "openclaw/plugin-sdk";
import type { Issue, StateLabel } from "../providers/provider.js";
import type { IssueProvider } from "../providers/provider.js";
import { createProvider } from "../providers/index.js";
import { selectLevel } from "../model-selector.js";
import { getWorker, getSessionForLevel, readProjects } from "../projects.js";
import { dispatchTask } from "../dispatch.js";
import { getAllRoleIds, getLevelsForRole, getAllLevels, roleForLevel } from "../roles/index.js";
import {
  DEFAULT_WORKFLOW,
  getQueueLabels,
  getAllQueueLabels,
  getActiveLabel,
  detectRoleFromLabel as workflowDetectRole,
  type WorkflowConfig,
  type Role,
} from "../workflow.js";

// ---------------------------------------------------------------------------
// Backward compatibility exports (deprecated)
// ---------------------------------------------------------------------------

/**
 * @deprecated Use getQueueLabels(workflow, "dev") instead.
 */
export const DEV_LABELS: StateLabel[] = getQueueLabels(DEFAULT_WORKFLOW, "dev");

/**
 * @deprecated Use getQueueLabels(workflow, "qa") instead.
 */
export const QA_LABELS: StateLabel[] = getQueueLabels(DEFAULT_WORKFLOW, "qa");

/**
 * @deprecated Use getAllQueueLabels(workflow) instead.
 */
export const PRIORITY_ORDER: StateLabel[] = getAllQueueLabels(DEFAULT_WORKFLOW);

// ---------------------------------------------------------------------------
// Shared helpers (used by tick, work-start, auto-pickup)
// ---------------------------------------------------------------------------

export function detectLevelFromLabels(labels: string[]): string | null {
  const lower = labels.map((l) => l.toLowerCase());

  // Match role.level labels (e.g., "dev.senior", "qa.reviewer", "architect.opus")
  for (const l of lower) {
    const dot = l.indexOf(".");
    if (dot === -1) continue;
    const role = l.slice(0, dot);
    const level = l.slice(dot + 1);
    const roleLevels = getLevelsForRole(role);
    if (roleLevels.includes(level)) return level;
  }

  // Fallback: plain level name
  const all = getAllLevels();
  return all.find((l) => lower.includes(l)) ?? null;
}

/**
 * Detect role from a label using workflow config.
 */
export function detectRoleFromLabel(
  label: StateLabel,
  workflow: WorkflowConfig = DEFAULT_WORKFLOW,
): Role | null {
  return workflowDetectRole(workflow, label);
}

export async function findNextIssueForRole(
  provider: Pick<IssueProvider, "listIssuesByLabel">,
  role: Role,
  workflow: WorkflowConfig = DEFAULT_WORKFLOW,
): Promise<{ issue: Issue; label: StateLabel } | null> {
  const labels = getQueueLabels(workflow, role);
  for (const label of labels) {
    try {
      const issues = await provider.listIssuesByLabel(label);
      if (issues.length > 0) return { issue: issues[issues.length - 1], label };
    } catch { /* continue */ }
  }
  return null;
}

/**
 * Find next issue for any role (optional filter). Used by work_start for auto-detection.
 */
export async function findNextIssue(
  provider: Pick<IssueProvider, "listIssuesByLabel">,
  role?: Role,
  workflow: WorkflowConfig = DEFAULT_WORKFLOW,
): Promise<{ issue: Issue; label: StateLabel } | null> {
  const labels = role
    ? getQueueLabels(workflow, role)
    : getAllQueueLabels(workflow);

  for (const label of labels) {
    try {
      const issues = await provider.listIssuesByLabel(label);
      if (issues.length > 0) return { issue: issues[issues.length - 1], label };
    } catch { /* continue */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// projectTick
// ---------------------------------------------------------------------------

export type TickAction = {
  project: string;
  groupId: string;
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
  groupId: string;
  agentId?: string;
  sessionKey?: string;
  pluginConfig?: Record<string, unknown>;
  dryRun?: boolean;
  maxPickups?: number;
  /** Only attempt this role. Used by work_start to fill the other slot. */
  targetRole?: Role;
  /** Optional provider override (for testing). Uses createProvider if omitted. */
  provider?: Pick<IssueProvider, "listIssuesByLabel" | "transitionLabel" | "listComments">;
  /** Plugin runtime for direct API access (avoids CLI subprocess timeouts) */
  runtime?: PluginRuntime;
  /** Workflow config (defaults to DEFAULT_WORKFLOW) */
  workflow?: WorkflowConfig;
}): Promise<TickResult> {
  const {
    workspaceDir, groupId, agentId, sessionKey, pluginConfig, dryRun,
    maxPickups, targetRole, runtime,
    workflow = DEFAULT_WORKFLOW,
  } = opts;

  const project = (await readProjects(workspaceDir)).projects[groupId];
  if (!project) return { pickups: [], skipped: [{ reason: `Project not found: ${groupId}` }] };

  const provider = opts.provider ?? (await createProvider({ repo: project.repo, provider: project.provider })).provider;
  const roleExecution = project.roleExecution ?? "parallel";
  const roles: Role[] = targetRole ? [targetRole] : getAllRoleIds() as Role[];

  const pickups: TickAction[] = [];
  const skipped: TickResult["skipped"] = [];
  let pickupCount = 0;

  for (const role of roles) {
    if (maxPickups !== undefined && pickupCount >= maxPickups) {
      skipped.push({ role, reason: "Max pickups reached" });
      continue;
    }

    // Re-read fresh state (previous dispatch may have changed it)
    const fresh = (await readProjects(workspaceDir)).projects[groupId];
    if (!fresh) break;

    const worker = getWorker(fresh, role);
    if (worker.active) {
      skipped.push({ role, reason: `Already active (#${worker.issueId})` });
      continue;
    }
    // Check sequential role execution: any other role must be inactive
    const otherRoles = getAllRoleIds().filter(r => r !== role);
    if (roleExecution === "sequential" && otherRoles.some(r => getWorker(fresh, r as any).active)) {
      skipped.push({ role, reason: "Sequential: other role active" });
      continue;
    }

    const next = await findNextIssueForRole(provider, role, workflow);
    if (!next) continue;

    const { issue, label: currentLabel } = next;
    const targetLabel = getActiveLabel(workflow, role);

    // Level selection: label → heuristic
    const selectedLevel = resolveLevelForIssue(issue, role);

    if (dryRun) {
      pickups.push({
        project: project.name, groupId, issueId: issue.iid, issueTitle: issue.title, issueUrl: issue.web_url,
        role, level: selectedLevel,
        sessionAction: getSessionForLevel(worker, selectedLevel) ? "send" : "spawn",
        announcement: `[DRY RUN] Would pick up #${issue.iid}`,
      });
    } else {
      try {
        const dr = await dispatchTask({
          workspaceDir, agentId, groupId, project: fresh, issueId: issue.iid,
          issueTitle: issue.title, issueDescription: issue.description ?? "", issueUrl: issue.web_url,
          role, level: selectedLevel, fromLabel: currentLabel, toLabel: targetLabel,
          transitionLabel: (id, from, to) => provider.transitionLabel(id, from as StateLabel, to as StateLabel),
          provider: provider as IssueProvider,
          pluginConfig,
          channel: fresh.channel,
          sessionKey,
          runtime,
        });
        pickups.push({
          project: project.name, groupId, issueId: issue.iid, issueTitle: issue.title, issueUrl: issue.web_url,
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
 * Determine the level for an issue based on labels, role overrides, and heuristic fallback.
 */
function resolveLevelForIssue(issue: Issue, role: Role): string {
  const labelLevel = detectLevelFromLabels(issue.labels);
  if (labelLevel) {
    const labelRole = roleForLevel(labelLevel);
    // If label level belongs to a different role, use heuristic for correct role
    if (labelRole && labelRole !== role) return selectLevel(issue.title, issue.description ?? "", role).level;
    return labelLevel;
  }
  return selectLevel(issue.title, issue.description ?? "", role).level;
}
