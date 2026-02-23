/**
 * Health service — worker health checks and auto-fix.
 *
 * Triangulates THREE sources of truth:
 *   1. projects.json — worker state (active, issueId, sessions per level)
 *   2. Issue label — current GitHub/GitLab label (from workflow config)
 *   3. Session state — whether the OpenClaw session exists via gateway status (including abortedLastRun flag)
 *
 * Detection matrix:
 *   | projects.json | Issue label       | Session state           | Action                                    |
 *   |---------------|-------------------|-------------------------|-------------------------------------------|
 *   | active        | Active label      | abortedLastRun: true    | HEAL: Revert to queue + clear session     |
 *   | active        | Active label      | dead/missing            | Deactivate worker, revert to queue        |
 *   | active        | NOT Active label  | any                     | Deactivate worker (moved externally)      |
 *   | active        | Active label      | alive + normal          | Healthy (flag if stale >2h)               |
 *   | inactive      | Active label      | any                     | Revert issue to queue (label stuck)       |
 *   | inactive      | issueId set       | any                     | Clear issueId (warning)                   |
 *   | active        | issue deleted     | any                     | Deactivate worker, clear state            |
 *
 * Session state notes:
 *   - gateway status `sessions.recent` is capped at 10 entries. We avoid this cap by
 *     reading session keys directly from the session files listed in `sessions.paths`.
 *   - Grace period: workers activated within the last GRACE_PERIOD_MS are never
 *     considered session-dead (they may not appear in sessions yet).
 *   - abortedLastRun: indicates session hit context limit (#287, #290) — triggers immediate healing.
 */
import type { StateLabel, IssueProvider, Issue } from "../providers/provider.js";
import {
  getRoleWorker,
  updateSlot,
  deactivateWorker,
  type Project,
} from "../projects.js";
import { log as auditLog } from "../audit.js";
import {
  DEFAULT_WORKFLOW,
  getActiveLabel,
  getRevertLabel,
  hasWorkflowStates,
  getCurrentStateLabel,
  isOwnedByOrUnclaimed,
  type WorkflowConfig,
  type Role,
} from "../workflow.js";
import { isSessionAlive, type SessionLookup } from "./gateway-sessions.js";

// Re-export for consumers that import from health.ts
export { fetchGatewaySessions, isSessionAlive, type GatewaySession, type SessionLookup } from "./gateway-sessions.js";

/** Grace period: skip session-dead checks for workers started within this window. */
export const GRACE_PERIOD_MS = 5 * 60 * 1_000; // 5 minutes

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HealthIssue = {
  type:
    | "session_dead"         // Case 1: active worker but session missing/dead
    | "label_mismatch"       // Case 2: active worker but issue not in active label
    | "stale_worker"         // Case 3: active for >2h
    | "stuck_label"          // Case 4: inactive but issue still has active label
    | "orphan_issue_id"      // Case 5: inactive but issueId set
    | "issue_gone"           // Case 6: active but issue deleted/inaccessible
    | "issue_closed"         // Case 6b: active but issue closed externally
    | "orphaned_label"        // Case 7: active label but no worker tracking it
    | "context_overflow";    // Case 1c: active worker but session hit context limit (abortedLastRun)
  severity: "critical" | "warning";
  project: string;
  projectSlug: string;
  role: Role;
  message: string;
  level?: string | null;
  sessionKey?: string | null;
  hoursActive?: number;
  issueId?: string | null;
  expectedLabel?: string;
  actualLabel?: string | null;
  slotIndex?: number;
};

export type HealthFix = {
  issue: HealthIssue;
  fixed: boolean;
  labelReverted?: string;
  labelRevertFailed?: boolean;
};

// ---------------------------------------------------------------------------
// Issue label lookup
// ---------------------------------------------------------------------------

/**
 * Fetch current issue state from the provider.
 * Returns null if issue doesn't exist or is inaccessible.
 */
async function fetchIssue(
  provider: IssueProvider,
  issueId: number,
): Promise<Issue | null> {
  try {
    return await provider.getIssue(issueId);
  } catch {
    return null; // Issue deleted, closed, or inaccessible
  }
}

/** Check if an issue is closed (GitHub returns "CLOSED", GitLab returns "closed"). */
function isIssueClosed(issue: Issue): boolean {
  return issue.state.toLowerCase() === "closed";
}

// ---------------------------------------------------------------------------
// Health check logic
// ---------------------------------------------------------------------------


export async function checkWorkerHealth(opts: {
  workspaceDir: string;
  projectSlug: string;
  project: Project;
  role: Role;
  autoFix: boolean;
  provider: IssueProvider;
  sessions: SessionLookup | null;
  /** Workflow config (defaults to DEFAULT_WORKFLOW) */
  workflow?: WorkflowConfig;
  /** Hours after which an active worker is considered stale (default: 2) */
  staleWorkerHours?: number;
}): Promise<HealthFix[]> {
  const {
    workspaceDir, projectSlug, project, role, autoFix, provider, sessions,
    workflow = DEFAULT_WORKFLOW,
    staleWorkerHours = 2,
  } = opts;

  const fixes: HealthFix[] = [];

  // Skip roles without workflow states (e.g. architect — tool-triggered only)
  if (!hasWorkflowStates(workflow, role)) return fixes;

  const roleWorker = getRoleWorker(project, role);

  // Get labels from workflow config
  const expectedLabel = getActiveLabel(workflow, role);
  const queueLabel = getRevertLabel(workflow, role);

  // Iterate over all levels and their slots
  for (const [level, slots] of Object.entries(roleWorker.levels)) {
    for (let slotIndex = 0; slotIndex < slots.length; slotIndex++) {
      const slot = slots[slotIndex]!;
      const sessionKey = slot.sessionKey;

      // Use the label stored at dispatch time (previousLabel) if available
      const slotQueueLabel: string = slot.previousLabel ?? queueLabel;

      // Grace period: skip session liveness checks for recently-started workers
      const workerStartTime = slot.startTime ? new Date(slot.startTime).getTime() : null;
      const withinGracePeriod = workerStartTime !== null && (Date.now() - workerStartTime) < GRACE_PERIOD_MS;

      // Parse issueId
      const issueIdNum = slot.issueId ? Number(slot.issueId) : null;

      // Fetch issue state if we have an issueId
      let issue: Issue | null = null;
      let currentLabel: StateLabel | null = null;
      if (issueIdNum) {
        issue = await fetchIssue(provider, issueIdNum);
        currentLabel = issue ? getCurrentStateLabel(issue.labels, workflow) : null;
      }

      // Helper to revert label for this issue
      async function revertLabel(fix: HealthFix, from: StateLabel, to: StateLabel) {
        if (!issueIdNum) return;
        try {
          await provider.transitionLabel(issueIdNum, from, to);
          fix.labelReverted = `${from} → ${to}`;
        } catch {
          fix.labelRevertFailed = true;
        }
      }

      // Helper to deactivate this slot
      async function deactivateSlot() {
        await deactivateWorker(workspaceDir, projectSlug, role, {
          level,
          slotIndex,
          issueId: slot.issueId ?? undefined,
        });
      }

      // Case 6: Active but issue doesn't exist (deleted/closed externally)
      if (slot.active && issueIdNum && !issue) {
        const fix: HealthFix = {
          issue: {
            type: "issue_gone",
            severity: "critical",
            project: project.name,
            projectSlug,
            role,
            level,
            sessionKey,
            issueId: slot.issueId,
            slotIndex,
            message: `${role.toUpperCase()} ${level}[${slotIndex}] active but issue #${issueIdNum} no longer exists or is closed`,
          },
          fixed: false,
        };
        if (autoFix) {
          await deactivateSlot();
          fix.fixed = true;
        }
        fixes.push(fix);
        continue;
      }

      // Case 6b: Active but issue is closed (externally or by another process)
      // getIssue() returns closed issues on GitHub/GitLab, so Case 6 doesn't catch this.
      if (slot.active && issue && isIssueClosed(issue)) {
        const fix: HealthFix = {
          issue: {
            type: "issue_closed",
            severity: "critical",
            project: project.name,
            projectSlug,
            role,
            level,
            sessionKey,
            issueId: slot.issueId,
            slotIndex,
            message: `${role.toUpperCase()} ${level}[${slotIndex}] active but issue #${issueIdNum} is closed`,
          },
          fixed: false,
        };
        if (autoFix) {
          await deactivateSlot();
          fix.fixed = true;
        }
        fixes.push(fix);
        continue;
      }

      // Case 2: Active but issue label is NOT the expected in-progress label
      if (slot.active && issue && currentLabel !== expectedLabel) {
        const fix: HealthFix = {
          issue: {
            type: "label_mismatch",
            severity: "critical",
            project: project.name,
            projectSlug,
            role,
            level,
            sessionKey,
            issueId: slot.issueId,
            expectedLabel,
            actualLabel: currentLabel,
            slotIndex,
            message: `${role.toUpperCase()} ${level}[${slotIndex}] active but issue #${issueIdNum} has label "${currentLabel}" (expected "${expectedLabel}")`,
          },
          fixed: false,
        };
        if (autoFix) {
          await deactivateSlot();
          fix.fixed = true;
        }
        fixes.push(fix);
        continue;
      }

      // Case 1: Active with correct label but session is dead/missing
      if (slot.active && sessionKey && sessions && !withinGracePeriod && !isSessionAlive(sessionKey, sessions)) {
        const fix: HealthFix = {
          issue: {
            type: "session_dead",
            severity: "critical",
            project: project.name,
            projectSlug,
            role,
            sessionKey,
            level,
            issueId: slot.issueId,
            slotIndex,
            message: `${role.toUpperCase()} ${level}[${slotIndex}] active but session "${sessionKey}" not found in gateway`,
          },
          fixed: false,
        };
        if (autoFix) {
          await revertLabel(fix, expectedLabel, slotQueueLabel);
          await deactivateSlot();
          fix.fixed = true;
        }
        fixes.push(fix);
        continue;
      }

      // Case 1b: Active but no session key at all
      if (slot.active && !sessionKey) {
        const fix: HealthFix = {
          issue: {
            type: "session_dead",
            severity: "critical",
            project: project.name,
            projectSlug,
            role,
            level,
            issueId: slot.issueId,
            slotIndex,
            message: `${role.toUpperCase()} ${level}[${slotIndex}] active but no session key`,
          },
          fixed: false,
        };
        if (autoFix) {
          if (issue && currentLabel === expectedLabel) {
            await revertLabel(fix, expectedLabel, slotQueueLabel);
          }
          await deactivateSlot();
          fix.fixed = true;
        }
        fixes.push(fix);
        continue;
      }

      // Case 1c: Active with correct label but session hit context limit (abortedLastRun)
      if (slot.active && sessionKey && sessions && isSessionAlive(sessionKey, sessions)) {
        const session = sessions.get(sessionKey);
        if (session?.abortedLastRun) {
          const fix: HealthFix = {
            issue: {
              type: "context_overflow",
              severity: "critical",
              project: project.name,
              projectSlug,
              role,
              sessionKey,
              level,
              issueId: slot.issueId,
              expectedLabel,
              actualLabel: currentLabel,
              slotIndex,
              message: `${role.toUpperCase()} ${level}[${slotIndex}] session "${sessionKey}" hit context limit (abortedLastRun: true). Healing by reverting to queue.`,
            },
            fixed: false,
          };
          if (autoFix) {
            if (issue && currentLabel === expectedLabel) {
              await revertLabel(fix, expectedLabel, slotQueueLabel);
            }
            await deactivateSlot();
            fix.fixed = true;
          }
          fixes.push(fix);
          await auditLog(workspaceDir, "context_overflow_healed", {
            project: project.name,
            projectSlug,
            role,
            issueId: slot.issueId,
            sessionKey,
            level,
            slotIndex,
          }).catch(() => {});
          continue;
        }
      }

      // Case 3: Active with correct label and alive session — check for staleness
      if (slot.active && slot.startTime && sessionKey && sessions && isSessionAlive(sessionKey, sessions)) {
        const hours = (Date.now() - new Date(slot.startTime).getTime()) / 3_600_000;
        if (hours > staleWorkerHours) {
          const fix: HealthFix = {
            issue: {
              type: "stale_worker",
              severity: "warning",
              project: project.name,
              projectSlug,
              role,
              hoursActive: Math.round(hours * 10) / 10,
              sessionKey,
              issueId: slot.issueId,
              slotIndex,
              message: `${role.toUpperCase()} ${level}[${slotIndex}] active for ${Math.round(hours * 10) / 10}h — may need attention`,
            },
            fixed: false,
          };
          if (autoFix) {
            await revertLabel(fix, expectedLabel, slotQueueLabel);
            await deactivateSlot();
            fix.fixed = true;
          }
          fixes.push(fix);
        }
      }

      // Case 4: Inactive but issue has stuck active label
      if (!slot.active && issue && currentLabel === expectedLabel) {
        const fix: HealthFix = {
          issue: {
            type: "stuck_label",
            severity: "critical",
            project: project.name,
            projectSlug,
            role,
            issueId: slot.issueId,
            expectedLabel: slotQueueLabel,
            actualLabel: currentLabel,
            slotIndex,
            message: `${role.toUpperCase()} ${level}[${slotIndex}] inactive but issue #${issueIdNum} still has "${currentLabel}" label`,
          },
          fixed: false,
        };
        if (autoFix) {
          await revertLabel(fix, expectedLabel, slotQueueLabel);
          // Clear the slot's issueId
          if (slot.issueId) {
            await updateSlot(workspaceDir, projectSlug, role, level, slotIndex, { issueId: null });
          }
          fix.fixed = true;
        }
        fixes.push(fix);
        continue;
      }

      // Case 5: Inactive but still has issueId set (orphan reference)
      if (!slot.active && slot.issueId) {
        const fix: HealthFix = {
          issue: {
            type: "orphan_issue_id",
            severity: "warning",
            project: project.name,
            projectSlug,
            role,
            issueId: slot.issueId,
            slotIndex,
            message: `${role.toUpperCase()} ${level}[${slotIndex}] inactive but still has issueId "${slot.issueId}"`,
          },
          fixed: false,
        };
        if (autoFix) {
          await updateSlot(workspaceDir, projectSlug, role, level, slotIndex, { issueId: null });
          fix.fixed = true;
        }
        fixes.push(fix);
      }
    }
  }

  return fixes;
}
// ---------------------------------------------------------------------------
// Orphaned label scan
// ---------------------------------------------------------------------------

/**
 * Scan for issues with active labels (Doing, Testing) that are NOT tracked
 * in projects.json. This catches cases where:
 * - Worker crashed and state was cleared (issueId: null)
 * - Label was set externally
 * - State corruption
 *
 * Returns fixes for all orphaned labels found.
 */
export async function scanOrphanedLabels(opts: {
  workspaceDir: string;
  projectSlug: string;
  project: Project;
  role: Role;
  autoFix: boolean;
  provider: IssueProvider;
  /** Workflow config (defaults to DEFAULT_WORKFLOW) */
  workflow?: WorkflowConfig;
  /** Instance name for ownership filtering. Only processes issues owned by this instance or unclaimed. */
  instanceName?: string;
}): Promise<HealthFix[]> {
  const {
    workspaceDir, projectSlug, project, role, autoFix, provider,
    workflow = DEFAULT_WORKFLOW,
    instanceName,
  } = opts;

  const fixes: HealthFix[] = [];

  // Skip roles without workflow states (e.g. architect — tool-triggered only)
  if (!hasWorkflowStates(workflow, role)) return fixes;

  const roleWorker = getRoleWorker(project, role);

  // Get labels from workflow config
  const activeLabel = getActiveLabel(workflow, role);
  const queueLabel = getRevertLabel(workflow, role);

  // Fetch all issues with the active label
  let issuesWithLabel: Issue[];
  try {
    issuesWithLabel = await provider.listIssuesByLabel(activeLabel);
  } catch {
    // Provider error (timeout, network, etc) — skip this scan
    return fixes;
  }

  // Filter by ownership: only process issues owned by this instance or unclaimed
  const ownedIssues = instanceName
    ? issuesWithLabel.filter((i) => isOwnedByOrUnclaimed(i.labels, instanceName))
    : issuesWithLabel;

  // Check each issue to see if it's tracked in any slot across all levels
  for (const issue of ownedIssues) {
    const issueIdStr = String(issue.iid);

    let isTracked = false;
    for (const slots of Object.values(roleWorker.levels)) {
      if (slots.some(slot => slot.active && slot.issueId === issueIdStr)) {
        isTracked = true;
        break;
      }
    }

    if (!isTracked) {
      // Orphaned label: issue has active label but no slot tracking it
      const fix: HealthFix = {
        issue: {
          type: "orphaned_label",
          severity: "critical",
          project: project.name,
          projectSlug,
          role,
          issueId: issueIdStr,
          expectedLabel: queueLabel,
          actualLabel: activeLabel,
          message: `Issue #${issue.iid} has "${activeLabel}" label but no ${role.toUpperCase()} slot is tracking it`,
        },
        fixed: false,
      };

      if (autoFix) {
        try {
          await provider.transitionLabel(issue.iid, activeLabel, queueLabel);
          fix.fixed = true;
          fix.labelReverted = `${activeLabel} → ${queueLabel}`;
        } catch {
          fix.labelRevertFailed = true;
        }
      }

      fixes.push(fix);
    }
  }

  return fixes;
}

