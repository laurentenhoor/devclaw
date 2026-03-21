/**
 * session.ts — Session management helpers for dispatch.
 */
import type { RunCommand } from "../context.js";
import { log as auditLog } from "../audit.js";
import { fetchGatewaySessions } from "../services/gateway-sessions.js";

// ---------------------------------------------------------------------------
// Context budget management
// ---------------------------------------------------------------------------

/**
 * Determine whether a session should be cleared based on context budget.
 *
 * Rules:
 * - If same issue (feedback cycle), keep session — worker needs prior context
 * - If context ratio exceeds sessionContextBudget, clear
 */
export async function shouldClearSession(
  sessionKey: string,
  slotIssueId: string | null,
  newIssueId: number,
  timeouts: import("../config/types.js").ResolvedTimeouts,
  workspaceDir: string,
  projectName: string,
  runCommand: RunCommand,
): Promise<boolean> {
  // Don't clear if re-dispatching for the same issue (feedback cycle)
  if (slotIssueId && String(newIssueId) === String(slotIssueId)) {
    return false;
  }

  // Check context budget via gateway session data
  try {
    const sessions = await fetchGatewaySessions(undefined, runCommand);
    if (!sessions) return false; // Gateway unavailable — don't clear

    const session = sessions.get(sessionKey);
    if (!session) return false; // Session not found — will be spawned fresh anyway

    const ratio = session.percentUsed / 100;
    if (ratio > timeouts.sessionContextBudget) {
      await auditLog(workspaceDir, "session_budget_reset", {
        project: projectName,
        sessionKey,
        reason: "context_budget",
        percentUsed: session.percentUsed,
        threshold: timeouts.sessionContextBudget * 100,
        totalTokens: session.totalTokens,
        contextTokens: session.contextTokens,
      });
      return true;
    }
  } catch {
    // Gateway query failed — don't clear, let dispatch proceed normally
  }

  return false;
}

// ---------------------------------------------------------------------------
// Private helpers — exist so dispatchTask reads as a sequence of steps
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget session creation/update.
 * Session key is deterministic, so we don't need to wait for confirmation.
 * If this fails, health check will catch orphaned state later.
 */
export function ensureSessionFireAndForget(sessionKey: string, model: string, workspaceDir: string, runCommand: RunCommand, timeoutMs = 30_000, label?: string): void {
  const rc = runCommand;
  const params: Record<string, unknown> = { key: sessionKey, model };
  if (label) params.label = label;
  rc(
    ["openclaw", "gateway", "call", "sessions.patch", "--params", JSON.stringify(params)],
    { timeoutMs },
  ).catch((err) => {
    auditLog(workspaceDir, "dispatch_warning", {
      step: "ensureSession", sessionKey,
      error: (err as Error).message ?? String(err),
    }).catch(() => {});
  });
}

/** Same shape as `resolveNotifyChannel()` — used to pass Telegram chat/topic into the gateway agent run. */
export type NotifyRoutingTarget = {
  channelId: string;
  channel: string;
  accountId?: string;
  messageThreadId?: number;
};

function applyNotifyRoutingToGatewayParams(
  params: Record<string, unknown>,
  target: NotifyRoutingTarget | undefined,
): void {
  if (!target?.channelId) {
    return;
  }
  params.to = target.channelId;
  params.channel = target.channel;
  if (target.accountId) {
    params.accountId = target.accountId;
  }
  if (target.messageThreadId != null && Number.isFinite(Number(target.messageThreadId))) {
    params.threadId = String(Math.trunc(Number(target.messageThreadId)));
  }
}

export function sendToAgent(
  sessionKey: string, taskMessage: string,
  opts: {
    agentId?: string;
    projectName: string;
    issueId: number;
    role: string;
    level?: string;
    slotIndex?: number;
    fromLabel?: string;
    orchestratorSessionKey?: string;
    workspaceDir: string;
    dispatchTimeoutMs?: number;
    extraSystemPrompt?: string;
    runCommand: RunCommand;
    /**
     * When set (e.g. from `resolveNotifyChannel`), forwarded to the gateway `agent` call as
     * `to`, `channel`, `accountId`, and `threadId` so plugin tools get `messageThreadId` injection
     * (Telegram forum topics) on the worker run.
     */
    notifyTarget?: NotifyRoutingTarget;
  },
): void {
  const rc = opts.runCommand;
  const gatewayParamsRecord: Record<string, unknown> = {
    idempotencyKey: `devclaw-${opts.projectName}-${opts.issueId}-${opts.role}-${opts.level ?? "unknown"}-${opts.slotIndex ?? 0}-${opts.fromLabel ?? "unknown"}-${sessionKey}`,
    agentId: opts.agentId ?? "devclaw",
    sessionKey,
    message: taskMessage,
    deliver: false,
    lane: "subagent",
    ...(opts.orchestratorSessionKey ? { spawnedBy: opts.orchestratorSessionKey } : {}),
    ...(opts.extraSystemPrompt ? { extraSystemPrompt: opts.extraSystemPrompt } : {}),
  };
  applyNotifyRoutingToGatewayParams(gatewayParamsRecord, opts.notifyTarget);
  const gatewayParams = JSON.stringify(gatewayParamsRecord);
  // Fire-and-forget: long-running agent turn, don't await
  rc(
    ["openclaw", "gateway", "call", "agent", "--params", gatewayParams, "--expect-final", "--json"],
    { timeoutMs: opts.dispatchTimeoutMs ?? 600_000 },
  ).catch((err) => {
    auditLog(opts.workspaceDir, "dispatch_warning", {
      step: "sendToAgent", sessionKey,
      issue: opts.issueId, role: opts.role,
      error: (err as Error).message ?? String(err),
    }).catch(() => {});
  });
}
