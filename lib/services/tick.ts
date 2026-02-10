/**
 * tick.ts — Project-level queue scan + dispatch.
 *
 * Core function: projectTick() scans one project's queue and fills free worker slots.
 * Called by: work_start (fill parallel slot), work_finish (next pipeline step), auto_pickup (sweep).
 */
import type { Issue, StateLabel } from "../providers/provider.js";
import type { IssueProvider } from "../providers/provider.js";
import { createProvider } from "../providers/index.js";
import { selectTier } from "../model-selector.js";
import { getWorker, getSessionForTier, readProjects } from "../projects.js";
import { dispatchTask } from "../dispatch.js";
import { ALL_TIERS, type Tier } from "../tiers.js";

// ---------------------------------------------------------------------------
// Shared constants + helpers (used by tick, work-start, auto-pickup)
// ---------------------------------------------------------------------------

export const DEV_LABELS: StateLabel[] = ["To Do", "To Improve"];
export const QA_LABELS: StateLabel[] = ["To Test"];
export const PRIORITY_ORDER: StateLabel[] = ["To Improve", "To Test", "To Do"];

export function detectTierFromLabels(labels: string[]): Tier | null {
  const lower = labels.map((l) => l.toLowerCase());
  return (ALL_TIERS as readonly string[]).find((t) => lower.includes(t)) as Tier | undefined ?? null;
}

export function detectRoleFromLabel(label: StateLabel): "dev" | "qa" | null {
  if (DEV_LABELS.includes(label)) return "dev";
  if (QA_LABELS.includes(label)) return "qa";
  return null;
}

export async function findNextIssueForRole(
  provider: Pick<IssueProvider, "listIssuesByLabel">,
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

/**
 * Find next issue for any role (optional filter). Used by work_start for auto-detection.
 */
export async function findNextIssue(
  provider: Pick<IssueProvider, "listIssuesByLabel">,
  role?: "dev" | "qa",
): Promise<{ issue: Issue; label: StateLabel } | null> {
  const labels = role === "dev" ? PRIORITY_ORDER.filter((l) => DEV_LABELS.includes(l))
    : role === "qa" ? PRIORITY_ORDER.filter((l) => QA_LABELS.includes(l))
    : PRIORITY_ORDER;
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
  role: "dev" | "qa";
  tier: string;
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
 * Does NOT run health checks (that's auto_pickup's job).
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
  targetRole?: "dev" | "qa";
}): Promise<TickResult> {
  const { workspaceDir, groupId, agentId, sessionKey, pluginConfig, dryRun, maxPickups, targetRole } = opts;

  const project = (await readProjects(workspaceDir)).projects[groupId];
  if (!project) return { pickups: [], skipped: [{ reason: `Project not found: ${groupId}` }] };

  const { provider } = createProvider({ repo: project.repo });
  const roleExecution = project.roleExecution ?? "parallel";
  const roles: Array<"dev" | "qa"> = targetRole ? [targetRole] : ["dev", "qa"];

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
    if (roleExecution === "sequential" && getWorker(fresh, role === "dev" ? "qa" : "dev").active) {
      skipped.push({ role, reason: "Sequential: other role active" });
      continue;
    }

    const next = await findNextIssueForRole(provider, role);
    if (!next) continue;

    const { issue, label: currentLabel } = next;
    const targetLabel: StateLabel = role === "dev" ? "Doing" : "Testing";

    // Tier selection: label → heuristic
    const selectedTier = resolveTierForIssue(issue, role);

    if (dryRun) {
      pickups.push({
        project: project.name, groupId, issueId: issue.iid, issueTitle: issue.title, issueUrl: issue.web_url,
        role, tier: selectedTier,
        sessionAction: getSessionForTier(worker, selectedTier) ? "send" : "spawn",
        announcement: `[DRY RUN] Would pick up #${issue.iid}`,
      });
    } else {
      try {
        const dr = await dispatchTask({
          workspaceDir, agentId, groupId, project: fresh, issueId: issue.iid,
          issueTitle: issue.title, issueDescription: issue.description ?? "", issueUrl: issue.web_url,
          role, tier: selectedTier, fromLabel: currentLabel, toLabel: targetLabel,
          transitionLabel: (id, from, to) => provider.transitionLabel(id, from as StateLabel, to as StateLabel),
          pluginConfig, sessionKey,
        });
        pickups.push({
          project: project.name, groupId, issueId: issue.iid, issueTitle: issue.title, issueUrl: issue.web_url,
          role, tier: dr.tier, sessionAction: dr.sessionAction, announcement: dr.announcement,
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
 * Determine the tier for an issue based on labels, role overrides, and heuristic fallback.
 */
function resolveTierForIssue(issue: Issue, role: "dev" | "qa"): string {
  const labelTier = detectTierFromLabels(issue.labels);
  if (labelTier) {
    if (role === "qa" && labelTier !== "qa") return "qa";
    if (role === "dev" && labelTier === "qa") return selectTier(issue.title, issue.description ?? "", role).tier;
    return labelTier;
  }
  return selectTier(issue.title, issue.description ?? "", role).tier;
}
