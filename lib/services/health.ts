/**
 * Health service — worker health checks and auto-fix.
 *
 * Triangulates THREE sources of truth:
 *   1. projects.json — worker state (active, issueId, level, sessions)
 *   2. Issue label — current GitHub/GitLab label (from workflow config)
 *   3. Session state — whether the OpenClaw session exists via gateway status (including abortedLastRun flag)
 *
 * Detection matrix:
 *   | projects.json | Issue label       | Session state           | Action                                    |
 *   |---------------|-------------------|-------------------------|-------------------------------------------|
 *   | active        | Active label ✅    | abortedLastRun: true    | HEAL: Revert to queue + clear session     |
 *   | active        | Active label ✅    | dead/missing            | Deactivate worker, revert to queue        |
 *   | active        | NOT Active label  | any                     | Deactivate worker (moved externally)      |
 *   | active        | Active label ✅    | alive + normal          | Healthy (flag if stale >2h)               |
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
  getSessionForLevel,
  getWorker,
  updateWorker,
  readProjects,
  type Project,
  type ProjectsData,
} from "../projects.js";
import { runCommand } from "../run-command.js";
import { log as auditLog } from "../audit.js";
import {
  DEFAULT_WORKFLOW,
  getActiveLabel,
  getRevertLabel,
  hasWorkflowStates,
  getCurrentStateLabel,
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
    | "issue_gone"           // Case 6: active but issue deleted/closed
    | "orphaned_label"        // Case 7: active label but no worker tracking it
    | "orphaned_session"      // Case 8: gateway session exists but not tracked in projects.json
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

  const worker = getWorker(project, role);
  const sessionKey = worker.level ? getSessionForLevel(worker, worker.level) : null;

  // Get labels from workflow config
  const expectedLabel = getActiveLabel(workflow, role);
  // Use the label stored at dispatch time (previousLabel) if available.
  // This ensures we revert to "To Improve" instead of always "To Do" when
  // a worker was dispatched from a non-standard queue state.
  const queueLabel: string = worker.previousLabel ?? getRevertLabel(workflow, role);

  // Grace period: skip session liveness checks for recently-started workers.
  // A freshly dispatched worker may not appear in gateway sessions yet.
  const workerStartTime = worker.startTime ? new Date(worker.startTime).getTime() : null;
  const withinGracePeriod = workerStartTime !== null && (Date.now() - workerStartTime) < GRACE_PERIOD_MS;

  // Parse issueId (may be comma-separated for batch, take first)
  const issueIdNum = worker.issueId ? Number(worker.issueId.split(",")[0]) : null;

  // Fetch issue state if we have an issueId
  let issue: Issue | null = null;
  let currentLabel: StateLabel | null = null;
  if (issueIdNum) {
    issue = await fetchIssue(provider, issueIdNum);
    currentLabel = issue ? getCurrentStateLabel(issue.labels, workflow) : null;
  }

  // Helper to revert label
  async function revertLabel(fix: HealthFix, from: StateLabel, to: StateLabel) {
    if (!issueIdNum) return;
    try {
      await provider.transitionLabel(issueIdNum, from, to);
      fix.labelReverted = `${from} → ${to}`;
    } catch {
      fix.labelRevertFailed = true;
    }
  }

  // Helper to deactivate worker
  async function deactivate(clearSessions = false) {
    const updates: Record<string, unknown> = {
      active: false,
      issueId: null,
      startTime: null,
    };
    if (clearSessions && worker.level) {
      updates.sessions = { ...worker.sessions, [worker.level]: null };
    }
    await updateWorker(workspaceDir, projectSlug, role, updates);
  }

  // ---------------------------------------------------------------------------
  // Case 6: Active but issue doesn't exist (deleted/closed externally)
  // ---------------------------------------------------------------------------
  if (worker.active && issueIdNum && !issue) {
    const fix: HealthFix = {
      issue: {
        type: "issue_gone",
        severity: "critical",
        project: project.name,
        projectSlug,
        role,
        level: worker.level,
        sessionKey,
        issueId: worker.issueId,
        message: `${role.toUpperCase()} active but issue #${issueIdNum} no longer exists or is closed`,
      },
      fixed: false,
    };
    if (autoFix) {
      await deactivate(true);
      fix.fixed = true;
    }
    fixes.push(fix);
    return fixes; // No point checking further
  }

  // ---------------------------------------------------------------------------
  // Case 2: Active but issue label is NOT the expected in-progress label
  // ---------------------------------------------------------------------------
  if (worker.active && issue && currentLabel !== expectedLabel) {
    const fix: HealthFix = {
      issue: {
        type: "label_mismatch",
        severity: "critical",
        project: project.name,
        projectSlug,
        role,
        level: worker.level,
        sessionKey,
        issueId: worker.issueId,
        expectedLabel,
        actualLabel: currentLabel,
        message: `${role.toUpperCase()} active but issue #${issueIdNum} has label "${currentLabel}" (expected "${expectedLabel}")`,
      },
      fixed: false,
    };
    if (autoFix) {
      await deactivate(true);
      fix.fixed = true;
    }
    fixes.push(fix);
    return fixes; // State is invalid, don't check session
  }

  // ---------------------------------------------------------------------------
  // Case 1: Active with correct label but session is dead/missing
  // Skip if:
  //   - sessions lookup unavailable (gateway timeout) — unknown ≠ dead
  //   - worker started within grace period (may not appear in gateway yet)
  // ---------------------------------------------------------------------------
  if (worker.active && sessionKey && sessions && !withinGracePeriod && !isSessionAlive(sessionKey, sessions)) {
    const fix: HealthFix = {
      issue: {
        type: "session_dead",
        severity: "critical",
        project: project.name,
        projectSlug,
        role,
        sessionKey,
        level: worker.level,
        issueId: worker.issueId,
        message: `${role.toUpperCase()} active but session "${sessionKey}" not found in gateway`,
      },
      fixed: false,
    };
    if (autoFix) {
      await revertLabel(fix, expectedLabel, queueLabel);
      await deactivate(true);
      fix.fixed = true;
    }
    fixes.push(fix);
    return fixes;
  }

  // ---------------------------------------------------------------------------
  // Case 1b: Active but no session key at all (shouldn't happen normally)
  // ---------------------------------------------------------------------------
  if (worker.active && !sessionKey) {
    const fix: HealthFix = {
      issue: {
        type: "session_dead",
        severity: "critical",
        project: project.name,
        projectSlug,
        role,
        level: worker.level,
        issueId: worker.issueId,
        message: `${role.toUpperCase()} active but no session key for level "${worker.level}"`,
      },
      fixed: false,
    };
    if (autoFix) {
      if (issue && currentLabel === expectedLabel) {
        await revertLabel(fix, expectedLabel, queueLabel);
      }
      await deactivate();
      fix.fixed = true;
    }
    fixes.push(fix);
    return fixes;
  }

  // ---------------------------------------------------------------------------
  // Case 1c: Active with correct label but session hit context limit (abortedLastRun)
  // This indicates the session was aborted due to context overflow (#287, #290)
  // Should heal immediately by reverting label and deactivating worker
  // ---------------------------------------------------------------------------
  if (worker.active && sessionKey && sessions && isSessionAlive(sessionKey, sessions)) {
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
          level: worker.level,
          issueId: worker.issueId,
          expectedLabel,
          actualLabel: currentLabel,
          message: `${role.toUpperCase()} session "${sessionKey}" hit context limit (abortedLastRun: true). Healing by reverting to queue.`,
        },
        fixed: false,
      };
      if (autoFix) {
        if (issue && currentLabel === expectedLabel) {
          await revertLabel(fix, expectedLabel, queueLabel);
        }
        // Clear the session for this level (force fresh start on next dispatch)
        await deactivate(true);
        fix.fixed = true;
      }
      fixes.push(fix);
      // Log the healing action for monitoring/correlation
      await auditLog(workspaceDir, "context_overflow_healed", {
        project: project.name,
        projectSlug,
        role,
        issueId: worker.issueId,
        sessionKey,
        level: worker.level,
      }).catch(() => {});
      return fixes; // Critical issue, stop checking further
    }
  }

  // ---------------------------------------------------------------------------
  // Case 3: Active with correct label and alive session — check for staleness
  // Skip if sessions lookup unavailable (gateway timeout)
  // ---------------------------------------------------------------------------
  if (worker.active && worker.startTime && sessionKey && sessions && isSessionAlive(sessionKey, sessions)) {
    const hours = (Date.now() - new Date(worker.startTime).getTime()) / 3_600_000;
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
          issueId: worker.issueId,
          message: `${role.toUpperCase()} active for ${Math.round(hours * 10) / 10}h — may need attention`,
        },
        fixed: false,
      };
      // Stale workers get auto-fixed: revert label and deactivate
      if (autoFix) {
        await revertLabel(fix, expectedLabel, queueLabel);
        await deactivate();
        fix.fixed = true;
      }
      fixes.push(fix);
    }
    // Otherwise: healthy, no issues to report
  }

  // ---------------------------------------------------------------------------
  // Case 4: Inactive but issue has stuck active label
  // ---------------------------------------------------------------------------
  if (!worker.active && issue && currentLabel === expectedLabel) {
    const fix: HealthFix = {
      issue: {
        type: "stuck_label",
        severity: "critical",
        project: project.name,
        projectSlug,
        role,
        issueId: worker.issueId,
        expectedLabel: queueLabel,
        actualLabel: currentLabel,
        message: `${role.toUpperCase()} inactive but issue #${issueIdNum} still has "${currentLabel}" label`,
      },
      fixed: false,
    };
    if (autoFix) {
      await revertLabel(fix, expectedLabel, queueLabel);
      // Also clear the issueId if present
      if (worker.issueId) {
        await updateWorker(workspaceDir, projectSlug, role, { issueId: null });
      }
      fix.fixed = true;
    }
    fixes.push(fix);
    return fixes;
  }

  // ---------------------------------------------------------------------------
  // Case 5: Inactive but still has issueId set (orphan reference)
  // ---------------------------------------------------------------------------
  if (!worker.active && worker.issueId) {
    const fix: HealthFix = {
      issue: {
        type: "orphan_issue_id",
        severity: "warning",
        project: project.name,
        projectSlug,
        role,
        issueId: worker.issueId,
        message: `${role.toUpperCase()} inactive but still has issueId "${worker.issueId}"`,
      },
      fixed: false,
    };
    if (autoFix) {
      await updateWorker(workspaceDir, projectSlug, role, { issueId: null });
      fix.fixed = true;
    }
    fixes.push(fix);
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
}): Promise<HealthFix[]> {
  const {
    workspaceDir, projectSlug, project, role, autoFix, provider,
    workflow = DEFAULT_WORKFLOW,
  } = opts;

  const fixes: HealthFix[] = [];

  // Skip roles without workflow states (e.g. architect — tool-triggered only)
  if (!hasWorkflowStates(workflow, role)) return fixes;

  const worker = getWorker(project, role);

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

  // Check each issue to see if it's tracked in worker state
  for (const issue of issuesWithLabel) {
    const issueIdStr = String(issue.iid);

    // Check if this issue is tracked
    const isTracked = worker.active && worker.issueId === issueIdStr;

    if (!isTracked) {
      // Orphaned label: issue has active label but no worker tracking it
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
          message: `Issue #${issue.iid} has "${activeLabel}" label but no ${role.toUpperCase()} worker is tracking it`,
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

// ---------------------------------------------------------------------------
// Orphaned session scan
// ---------------------------------------------------------------------------

/** Subagent session key pattern: agent:{agentId}:subagent:{project}-{role}-{level}-{slotIndex} */
const SUBAGENT_PATTERN = /^agent:[^:]+:subagent:/;

/**
 * Scan for gateway subagent sessions that are NOT tracked in any project's
 * worker sessions map. These are leftover from previous dispatches at
 * different levels and waste resources / contribute to session cap pressure.
 *
 * Returns fixes for all orphaned sessions found.
 */
export async function scanOrphanedSessions(opts: {
  workspaceDir: string;
  sessions: SessionLookup | null;
  autoFix: boolean;
}): Promise<HealthFix[]> {
  const { workspaceDir, sessions, autoFix } = opts;
  const fixes: HealthFix[] = [];

  // Skip if gateway unavailable
  if (!sessions) return fixes;

  // 1. Collect all known (tracked) session keys from projects.json
  const knownKeys = new Set<string>();
  const activeSessionKeys = new Set<string>();

  let data: ProjectsData;
  try {
    data = await readProjects(workspaceDir);
  } catch {
    return fixes; // Can't read projects — skip
  }

  for (const project of Object.values(data.projects)) {
    for (const [_role, rw] of Object.entries(project.workers)) {
      for (const slot of rw.slots) {
        if (slot.sessionKey) {
          knownKeys.add(slot.sessionKey);
          // Track active worker sessions (belt-and-suspenders: never delete these)
          if (slot.active) {
            activeSessionKeys.add(slot.sessionKey);
          }
        }
      }
    }
  }

  // 2. Find subagent sessions in gateway that aren't tracked
  for (const [key, _session] of sessions) {
    // Only consider subagent sessions
    if (!SUBAGENT_PATTERN.test(key)) continue;

    // Skip if tracked in projects.json
    if (knownKeys.has(key)) continue;

    // Belt-and-suspenders: never delete active worker sessions
    if (activeSessionKeys.has(key)) continue;

    const fix: HealthFix = {
      issue: {
        type: "orphaned_session",
        severity: "warning",
        project: "global",
        projectSlug: "global",
        role: "developer", // Placeholder — role is embedded in session key
        sessionKey: key,
        message: `Gateway session "${key}" is not tracked by any project worker`,
      },
      fixed: false,
    };

    if (autoFix) {
      try {
        await runCommand(
          ["openclaw", "gateway", "call", "sessions.delete", "--params", JSON.stringify({ key })],
          { timeoutMs: 10_000 },
        );
        fix.fixed = true;
      } catch {
        // Deletion failed — report but don't crash
      }
    }

    fixes.push(fix);
  }

  return fixes;
}
