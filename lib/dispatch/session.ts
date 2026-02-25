/**
 * session.ts — Session management helpers for dispatch.
 */
import type { RunCommand } from "../context.js";
import { log as auditLog } from "../audit.js";
import { fetchGatewaySessions } from "../services/gateway-sessions.js";
import type { PluginRuntime } from "openclaw/plugin-sdk";

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
// Session helpers
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget session creation/update.
 * Session key is deterministic, so we don't need to wait for confirmation.
 * If this fails, health check will catch orphaned state later.
 *
 * For worker sessions, enables verboseLevel: "on" for real-time streaming
 * of tool calls and intermediate output to the forum topic.
 */
export function ensureSessionFireAndForget(
  sessionKey: string,
  model: string,
  workspaceDir: string,
  runCommand: RunCommand,
  timeoutMs = 30_000,
  opts?: { label?: string; isWorkerSession?: boolean },
): void {
  const rc = runCommand;
  const params: Record<string, unknown> = { key: sessionKey, model };
  if (opts?.label) params.label = opts.label;
  if (opts?.isWorkerSession) params.verboseLevel = "on";

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

export function sendToAgent(
  sessionKey: string, taskMessage: string,
  opts: {
    agentId?: string; projectName: string; issueId: number; role: string;
    level?: string; slotIndex?: number; orchestratorSessionKey?: string;
    workspaceDir: string; dispatchTimeoutMs?: number; extraSystemPrompt?: string;
    runCommand: RunCommand; threadId?: number; groupId?: string;
  },
): void {
  const rc = opts.runCommand;
  const baseParams: Record<string, unknown> = {
    idempotencyKey: `devclaw-${opts.projectName}-${opts.issueId}-${opts.role}-${opts.level ?? "unknown"}-${opts.slotIndex ?? 0}-${sessionKey}`,
    agentId: opts.agentId ?? "devclaw",
    sessionKey,
    message: taskMessage,
    deliver: false,
    lane: "subagent",
    ...(opts.orchestratorSessionKey ? { spawnedBy: opts.orchestratorSessionKey } : {}),
    ...(opts.extraSystemPrompt ? { extraSystemPrompt: opts.extraSystemPrompt } : {}),
  };

  // Route to forum topic when available — enables real-time streaming visibility
  if (opts.threadId && opts.groupId) {
    baseParams.deliver = true;
    baseParams.to = opts.groupId;
    baseParams.threadId = opts.threadId;
    baseParams.channel = "telegram";
  }

  const gatewayParams = JSON.stringify(baseParams);
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

// ---------------------------------------------------------------------------
// Forum topic management
// ---------------------------------------------------------------------------

/**
 * Detect if a Telegram group is a forum supergroup.
 *
 * Uses an optimistic approach: assumes the group is a forum and lets
 * createWorkerTopic() handle errors if it's not. The result is cached
 * on Project.isForum after the first topic creation attempt.
 */
export async function detectForumGroup(
  _groupId: string,
  _runtime: PluginRuntime,
): Promise<boolean> {
  // Optimistic: assume forum, let createWorkerTopic handle errors.
  // On first failure with "method is available for supergroup" or similar,
  // the caller should set project.isForum = false to stop retrying.
  return true;
}

/**
 * Create a Telegram forum topic for a worker session.
 *
 * Topic name format: "{ROLE} {WorkerName} #{issueId}"
 * e.g. "DEV Cordelia #42"
 *
 * Uses the runtime's Telegram channel to call createForumTopicTelegram.
 * Returns the threadId on success, null on failure. Failures are non-blocking —
 * dispatch continues without a topic (output goes to General).
 */
export async function createWorkerTopic(
  groupId: string,
  role: string,
  workerName: string,
  issueId: number,
  runtime: PluginRuntime,
  workspaceDir: string,
): Promise<number | null> {
  const topicName = `${role.toUpperCase()} ${workerName} #${issueId}`;

  try {
    // Access createForumTopicTelegram via the runtime's channel.telegram
    // The function is part of the Telegram send module but may not be on the
    // typed runtime interface — use dynamic access as a pragmatic solution.
    const telegram = runtime.channel?.telegram as Record<string, unknown> | undefined;
    const createFn = telegram?.createForumTopicTelegram as
      | ((chatId: string, name: string) => Promise<{ topicId: number; name: string; chatId: string }>)
      | undefined;

    if (!createFn) {
      // createForumTopicTelegram not available on runtime — this version of
      // OpenClaw may not expose it. Log and skip topic creation.
      await auditLog(workspaceDir, "forum_topic_skipped", {
        groupId,
        topicName,
        reason: "createForumTopicTelegram not available on runtime",
      });
      return null;
    }

    const result = await createFn(groupId, topicName);

    if (result?.topicId) {
      await auditLog(workspaceDir, "forum_topic_created", {
        groupId,
        topicName,
        threadId: result.topicId,
        issueId,
      });
      return result.topicId;
    }

    return null;
  } catch (err) {
    const errMsg = (err as Error).message ?? String(err);

    // Detect non-forum errors to cache isForum=false upstream
    const isNotForum =
      errMsg.includes("not enough rights") ||
      errMsg.includes("CHAT_NOT_MODIFIED") ||
      errMsg.includes("method is available for supergroup") ||
      errMsg.includes("PEER_ID_INVALID");

    await auditLog(workspaceDir, isNotForum ? "forum_topic_not_available" : "forum_topic_error", {
      groupId,
      topicName,
      issueId,
      error: errMsg,
    });

    return null;
  }
}
