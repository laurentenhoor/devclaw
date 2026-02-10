/**
 * Health service — worker health checks and auto-fix.
 *
 * Detects: active_no_session, zombie_session, stale_worker, inactive_with_issue.
 * Used by both `status` (read-only) and `auto_pickup` (auto-fix).
 */
import type { StateLabel } from "../providers/provider.js";
import {
  getSessionForTier,
  getWorker,
  updateWorker,
  type Project,
} from "../projects.js";

export type HealthIssue = {
  type: "active_no_session" | "zombie_session" | "stale_worker" | "inactive_with_issue";
  severity: "critical" | "warning";
  project: string;
  groupId: string;
  role: "dev" | "qa";
  message: string;
  tier?: string | null;
  sessionKey?: string | null;
  hoursActive?: number;
  issueId?: string | null;
};

export type HealthFix = {
  issue: HealthIssue;
  fixed: boolean;
  labelReverted?: string;
  labelRevertFailed?: boolean;
};

export async function checkWorkerHealth(opts: {
  workspaceDir: string;
  groupId: string;
  project: Project;
  role: "dev" | "qa";
  activeSessions: string[];
  autoFix: boolean;
  provider: {
    transitionLabel(id: number, from: StateLabel, to: StateLabel): Promise<void>;
  };
}): Promise<HealthFix[]> {
  const { workspaceDir, groupId, project, role, activeSessions, autoFix, provider } = opts;
  const fixes: HealthFix[] = [];
  const worker = getWorker(project, role);
  const sessionKey = worker.tier ? getSessionForTier(worker, worker.tier) : null;

  const revertLabel: StateLabel = role === "dev" ? "To Do" : "To Test";
  const currentLabel: StateLabel = role === "dev" ? "Doing" : "Testing";

  async function revertIssueLabel(fix: HealthFix) {
    if (!worker.issueId) return;
    try {
      const id = Number(worker.issueId.split(",")[0]);
      await provider.transitionLabel(id, currentLabel, revertLabel);
      fix.labelReverted = `${currentLabel} → ${revertLabel}`;
    } catch {
      fix.labelRevertFailed = true;
    }
  }

  // Check 1: Active but no session key for current tier
  if (worker.active && !sessionKey) {
    const fix: HealthFix = {
      issue: {
        type: "active_no_session", severity: "critical",
        project: project.name, groupId, role,
        tier: worker.tier,
        message: `${role.toUpperCase()} active but no session for tier "${worker.tier}"`,
      },
      fixed: false,
    };
    if (autoFix) {
      await updateWorker(workspaceDir, groupId, role, { active: false, issueId: null });
      fix.fixed = true;
    }
    fixes.push(fix);
  }

  // Check 2: Active with session but session is dead (zombie)
  if (worker.active && sessionKey && activeSessions.length > 0 && !activeSessions.includes(sessionKey)) {
    const fix: HealthFix = {
      issue: {
        type: "zombie_session", severity: "critical",
        project: project.name, groupId, role,
        sessionKey, tier: worker.tier,
        message: `${role.toUpperCase()} session not in active sessions list`,
      },
      fixed: false,
    };
    if (autoFix) {
      await revertIssueLabel(fix);
      const sessions = { ...worker.sessions };
      if (worker.tier) sessions[worker.tier] = null;
      await updateWorker(workspaceDir, groupId, role, { active: false, issueId: null, sessions });
      fix.fixed = true;
    }
    fixes.push(fix);
  }

  // Check 3: Inactive but still has issueId
  if (!worker.active && worker.issueId) {
    const fix: HealthFix = {
      issue: {
        type: "inactive_with_issue", severity: "warning",
        project: project.name, groupId, role,
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

  // Check 4: Active for >2 hours (stale)
  if (worker.active && worker.startTime && sessionKey) {
    const hours = (Date.now() - new Date(worker.startTime).getTime()) / 3_600_000;
    if (hours > 2) {
      const fix: HealthFix = {
        issue: {
          type: "stale_worker", severity: "warning",
          project: project.name, groupId, role,
          hoursActive: Math.round(hours * 10) / 10,
          sessionKey, issueId: worker.issueId,
          message: `${role.toUpperCase()} active for ${Math.round(hours * 10) / 10}h — may need attention`,
        },
        fixed: false,
      };
      if (autoFix) {
        await revertIssueLabel(fix);
        await updateWorker(workspaceDir, groupId, role, { active: false, issueId: null });
        fix.fixed = true;
      }
      fixes.push(fix);
    }
  }

  return fixes;
}
