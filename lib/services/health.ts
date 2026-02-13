/**
 * Health service — worker health checks and auto-fix.
 *
 * Triangulates THREE sources of truth:
 *   1. projects.json — worker state (active, issueId, level, sessions)
 *   2. Issue label — current GitHub/GitLab label (Doing, Testing, To Do, etc.)
 *   3. Session state — whether the OpenClaw session exists via gateway status
 *
 * Detection matrix:
 *   | projects.json | Issue label       | Session      | Action                                    |
 *   |---------------|-------------------|--------------|-------------------------------------------|
 *   | active        | Doing/Testing ✅   | dead/missing | Deactivate worker, revert to To Do/To Test |
 *   | active        | NOT Doing/Testing | any          | Deactivate worker (moved externally)       |
 *   | active        | Doing/Testing ✅   | alive        | Healthy (flag if stale >2h)                |
 *   | inactive      | Doing/Testing     | any          | Revert issue to To Do/To Test (label stuck)|
 *   | inactive      | issueId set       | any          | Clear issueId (warning)                    |
 *   | active        | issue deleted     | any          | Deactivate worker, clear state             |
 */
import type { StateLabel, IssueProvider, Issue } from "../providers/provider.js";
import {
  getSessionForLevel,
  getWorker,
  updateWorker,
  type Project,
} from "../projects.js";
import { runCommand } from "../run-command.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HealthIssue = {
  type:
    | "session_dead"         // Case 1: active worker but session missing/dead
    | "label_mismatch"       // Case 2: active worker but issue not in Doing/Testing
    | "stale_worker"         // Case 3: active for >2h
    | "stuck_label"          // Case 4: inactive but issue still has Doing/Testing
    | "orphan_issue_id"      // Case 5: inactive but issueId set
    | "issue_gone";          // Case 6: active but issue deleted/closed
  severity: "critical" | "warning";
  project: string;
  groupId: string;
  role: "dev" | "qa";
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
 * Caches result for the duration of a health check pass.
 */
export async function fetchGatewaySessions(): Promise<SessionLookup> {
  const lookup: SessionLookup = new Map();

  try {
    const result = await runCommand(
      ["openclaw", "gateway", "call", "status", "--json"],
      { timeoutMs: 15_000 },
    );

    const data = JSON.parse(result.stdout);
    const sessions: GatewaySession[] = data?.sessions?.recent ?? [];

    for (const session of sessions) {
      if (session.key) {
        lookup.set(session.key, session);
      }
    }
  } catch {
    // Gateway unavailable — return empty map (all sessions will be treated as missing)
  }

  return lookup;
}

/**
 * Check if a session key exists in the gateway and is considered "alive".
 * A session is alive if it exists. We don't consider percentUsed or abortedLastRun
 * as dead indicators — those are normal states for reusable sessions.
 */
function isSessionAlive(sessionKey: string, sessions: SessionLookup): boolean {
  return sessions.has(sessionKey);
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

/**
 * Expected in-progress labels for each role.
 */
const ACTIVE_LABELS: Record<"dev" | "qa", StateLabel> = {
  dev: "Doing",
  qa: "Testing",
};

/**
 * Queue labels to revert to when clearing stuck state.
 */
const QUEUE_LABELS: Record<"dev" | "qa", StateLabel> = {
  dev: "To Do",
  qa: "To Test",
};

export async function checkWorkerHealth(opts: {
  workspaceDir: string;
  groupId: string;
  project: Project;
  role: "dev" | "qa";
  autoFix: boolean;
  provider: IssueProvider;
  sessions: SessionLookup;
}): Promise<HealthFix[]> {
  const { workspaceDir, groupId, project, role, autoFix, provider, sessions } = opts;
  const fixes: HealthFix[] = [];
  const worker = getWorker(project, role);
  const sessionKey = worker.level ? getSessionForLevel(worker, worker.level) : null;

  const expectedLabel = ACTIVE_LABELS[role];
  const queueLabel = QUEUE_LABELS[role];

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
  // ---------------------------------------------------------------------------
  if (worker.active && sessionKey && !isSessionAlive(sessionKey, sessions)) {
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
  // ---------------------------------------------------------------------------
  if (worker.active && worker.startTime && sessionKey && isSessionAlive(sessionKey, sessions)) {
    const hours = (Date.now() - new Date(worker.startTime).getTime()) / 3_600_000;
    if (hours > 2) {
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
  // Case 4: Inactive but issue has stuck Doing/Testing label
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
