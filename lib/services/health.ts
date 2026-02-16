/**
 * Health service — worker health checks and auto-fix.
 *
 * Triangulates THREE sources of truth:
 *   1. projects.json — worker state (active, issueId, level, sessions)
 *   2. Issue label — current GitHub/GitLab label (from workflow config)
 *   3. Session state — whether the OpenClaw session exists via gateway status
 *
 * Detection matrix:
 *   | projects.json | Issue label       | Session      | Action                                    |
 *   |---------------|-------------------|--------------|-------------------------------------------|
 *   | active        | Active label ✅    | dead/missing | Deactivate worker, revert to queue        |
 *   | active        | NOT Active label  | any          | Deactivate worker (moved externally)      |
 *   | active        | Active label ✅    | alive        | Healthy (flag if stale >2h)               |
 *   | inactive      | Active label      | any          | Revert issue to queue (label stuck)       |
 *   | inactive      | issueId set       | any          | Clear issueId (warning)                   |
 *   | active        | issue deleted     | any          | Deactivate worker, clear state            |
 */
import type { StateLabel, IssueProvider, Issue } from "../providers/provider.js";
import {
  getSessionForLevel,
  getWorker,
  updateWorker,
  type Project,
} from "../projects.js";
import { runCommand } from "../run-command.js";
import {
  DEFAULT_WORKFLOW,
  getActiveLabel,
  getRevertLabel,
  hasWorkflowStates,
  type WorkflowConfig,
  type Role,
} from "../workflow.js";

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
    | "orphaned_label";      // Case 7: active label but no worker tracking it
  severity: "critical" | "warning";
  project: string;
  groupId: string;
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

export type GatewaySession = {
  key: string;
  updatedAt: number;
  percentUsed: number;
  abortedLastRun?: boolean;
};

export type SessionLookup = Map<string, GatewaySession>;

// ---------------------------------------------------------------------------
// Gateway session lookup
// ---------------------------------------------------------------------------

/**
 * Query gateway status and build a lookup map of active sessions.
 * Returns null if gateway is unavailable (timeout, error, etc).
 * Callers should skip session liveness checks if null — unknown ≠ dead.
 */
export async function fetchGatewaySessions(gatewayTimeoutMs = 15_000): Promise<SessionLookup | null> {
  const lookup: SessionLookup = new Map();

  try {
    const result = await runCommand(
      ["openclaw", "gateway", "call", "status", "--json"],
      { timeoutMs: gatewayTimeoutMs },
    );

    const jsonStart = result.stdout.indexOf("{");
    const data = JSON.parse(jsonStart >= 0 ? result.stdout.slice(jsonStart) : result.stdout);
    const sessions: GatewaySession[] = data?.sessions?.recent ?? [];

    for (const session of sessions) {
      if (session.key) {
        lookup.set(session.key, session);
      }
    }
    return lookup;
  } catch {
    // Gateway unavailable — return null (don't assume sessions are dead)
    return null;
  }
}

/**
 * Check if a session key exists in the gateway and is considered "alive".
 * A session is alive if it exists. We don't consider percentUsed or abortedLastRun
 * as dead indicators — those are normal states for reusable sessions.
 * Returns false if sessions lookup is null (gateway unavailable).
 */
function isSessionAlive(sessionKey: string, sessions: SessionLookup | null): boolean {
  return sessions ? sessions.has(sessionKey) : false;
}

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
  groupId: string;
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
    workspaceDir, groupId, project, role, autoFix, provider, sessions,
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
  const queueLabel = getRevertLabel(workflow, role);

  // Parse issueId (may be comma-separated for batch, take first)
  const issueIdNum = worker.issueId ? Number(worker.issueId.split(",")[0]) : null;

  // Fetch issue state if we have an issueId
  let issue: Issue | null = null;
  let currentLabel: StateLabel | null = null;
  if (issueIdNum) {
    issue = await fetchIssue(provider, issueIdNum);
    currentLabel = issue ? provider.getCurrentStateLabel(issue) : null;
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
    await updateWorker(workspaceDir, groupId, role, updates);
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
        groupId,
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
        groupId,
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
  // Skip if sessions lookup unavailable (gateway timeout) — unknown ≠ dead
  // ---------------------------------------------------------------------------
  if (worker.active && sessionKey && sessions && !isSessionAlive(sessionKey, sessions)) {
    const fix: HealthFix = {
      issue: {
        type: "session_dead",
        severity: "critical",
        project: project.name,
        groupId,
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
        groupId,
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
          groupId,
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
        groupId,
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
        await updateWorker(workspaceDir, groupId, role, { issueId: null });
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
        groupId,
        role,
        issueId: worker.issueId,
        message: `${role.toUpperCase()} inactive but still has issueId "${worker.issueId}"`,
      },
      fixed: false,
    };
    if (autoFix) {
      await updateWorker(workspaceDir, groupId, role, { issueId: null });
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
  groupId: string;
  project: Project;
  role: Role;
  autoFix: boolean;
  provider: IssueProvider;
  /** Workflow config (defaults to DEFAULT_WORKFLOW) */
  workflow?: WorkflowConfig;
}): Promise<HealthFix[]> {
  const {
    workspaceDir, groupId, project, role, autoFix, provider,
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
          groupId,
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
