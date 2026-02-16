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
import { getLevelsForRole } from "../roles/index.js";
import { loadConfig } from "../config/index.js";
import {
  ExecutionMode,
  ReviewPolicy,
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
  } = opts;

  const project = (await readProjects(workspaceDir)).projects[groupId];
  if (!project) return { pickups: [], skipped: [{ reason: `Project not found: ${groupId}` }] };

  const resolvedConfig = await loadConfig(workspaceDir, project.name);
  const workflow = opts.workflow ?? resolvedConfig.workflow;

  const provider = opts.provider ?? (await createProvider({ repo: project.repo, provider: project.provider })).provider;
  const roleExecution = project.roleExecution ?? ExecutionMode.PARALLEL;
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
    const fresh = (await readProjects(workspaceDir)).projects[groupId];
    if (!fresh) break;

    const worker = getWorker(fresh, role);
    if (worker.active) {
      skipped.push({ role, reason: `Already active (#${worker.issueId})` });
      continue;
    }
    // Check sequential role execution: any other role must be inactive
    const otherRoles = enabledRoles.filter((r: string) => r !== role);
    if (roleExecution === ExecutionMode.SEQUENTIAL && otherRoles.some((r: string) => getWorker(fresh, r).active)) {
      skipped.push({ role, reason: "Sequential: other role active" });
      continue;
    }

    // Review policy gate: fallback for issues dispatched before step routing labels existed
    if (role === "reviewer") {
      const policy = workflow.reviewPolicy ?? ReviewPolicy.AUTO;
      if (policy === ReviewPolicy.HUMAN) {
        skipped.push({ role, reason: "Review policy: human (heartbeat handles via PR polling)" });
        continue;
      }
    }

    const next = await findNextIssueForRole(provider, role, workflow);
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
