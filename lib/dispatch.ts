/**
 * dispatch.ts — Core dispatch logic shared by work_start and projectTick.
 *
 * Handles: session lookup, spawn/reuse via Gateway RPC, task dispatch via CLI,
 * state update (activateWorker), and audit logging.
 */
import type { PluginRuntime } from "openclaw/plugin-sdk";
import { log as auditLog } from "./audit.js";
import { runCommand } from "./run-command.js";
import {
  type Project,
  activateWorker,
  updateWorker,
  getSessionForLevel,
  getWorker,
} from "./projects.js";
import { fetchGatewaySessions, type GatewaySession } from "./services/gateway-sessions.js";
import { resolveModel, getFallbackEmoji } from "./roles/index.js";
import { notify, getNotificationConfig } from "./notify.js";
import { loadConfig, type ResolvedRoleConfig } from "./config/index.js";
import { ReviewPolicy, resolveReviewRouting, resolveNotifyChannel, isFeedbackState, hasReviewCheck, producesReviewableWork } from "./workflow.js";
import { fetchPrFeedback, fetchPrContext, formatPrContext, formatPrFeedback, type PrFeedback, type PrContext } from "./pr-context.js";

export type DispatchOpts = {
  workspaceDir: string;
  agentId?: string;
  project: Project;
  issueId: number;
  issueTitle: string;
  issueDescription: string;
  issueUrl: string;
  role: string;
  /** Developer level (junior, mid, senior) or raw model ID */
  level: string;
  /** Label to transition FROM (e.g. "To Do", "To Test", "To Improve") */
  fromLabel: string;
  /** Label to transition TO (e.g. "Doing", "Testing") */
  toLabel: string;
  /** Issue provider for issue operations and label transitions */
  provider: import("./providers/provider.js").IssueProvider;
  /** Plugin config for model resolution and notification config */
  pluginConfig?: Record<string, unknown>;
  /** Orchestrator's session key (used as spawnedBy for subagent tracking) */
  sessionKey?: string;
  /** Plugin runtime for direct API access (avoids CLI subprocess timeouts) */
  runtime?: PluginRuntime;
};

export type DispatchResult = {
  sessionAction: "spawn" | "send";
  sessionKey: string;
  level: string;
  model: string;
  announcement: string;
};

/**
 * Build the task message sent to a worker session.
 *
 * Role-specific instructions are no longer included in the message body.
 * They are injected via the agent:bootstrap hook (see bootstrap-hook.ts)
 * into the worker's system prompt as WORKER_INSTRUCTIONS.md.
 */
export function buildTaskMessage(opts: {
  projectName: string;
  projectSlug: string;
  role: string;
  issueId: number;
  issueTitle: string;
  issueDescription: string;
  issueUrl: string;
  repo: string;
  baseBranch: string;
  comments?: Array<{ author: string; body: string; created_at: string }>;
  resolvedRole?: ResolvedRoleConfig;
  prContext?: PrContext;
  prFeedback?: PrFeedback;
}): string {
  const {
    projectName, projectSlug, role, issueId, issueTitle,
    issueDescription, issueUrl, repo, baseBranch,
  } = opts;

  const results = opts.resolvedRole?.completionResults ?? [];
  const availableResults = results.map((r: string) => `"${r}"`).join(", ");

  const parts = [
    `${role.toUpperCase()} task for project "${projectName}" — Issue #${issueId}`,
    ``,
    issueTitle,
    issueDescription ? `\n${issueDescription}` : "",
  ];

  // Include comments if present
  if (opts.comments && opts.comments.length > 0) {
    parts.push(``, `## Comments`);
    // Limit to last 20 comments to avoid bloating context
    const recentComments = opts.comments.slice(-20);
    for (const comment of recentComments) {
      const date = new Date(comment.created_at).toLocaleString();
      parts.push(``, `**${comment.author}** (${date}):`, comment.body);
    }
  }

  if (opts.prContext) parts.push(...formatPrContext(opts.prContext));
  if (opts.prFeedback) parts.push(...formatPrFeedback(opts.prFeedback, baseBranch));

  parts.push(
    ``,
    `Repo: ${repo} | Branch: ${baseBranch} | ${issueUrl}`,
    `Project: ${projectSlug}`,
  );

  parts.push(
    ``, `---`, ``,
    `## MANDATORY: Task Completion`,
    ``,
    `When you finish this task, you MUST call \`work_finish\` with:`,
    `- \`role\`: "${role}"`,
    `- \`projectSlug\`: "${projectSlug}"`,
    `- \`result\`: ${availableResults}`,
    `- \`summary\`: brief description of what you did`,
    ``,
    `⚠️ You MUST call work_finish even if you encounter errors or cannot finish.`,
    `Use "blocked" with a summary explaining why you're stuck.`,
    `Never end your session without calling work_finish.`,
  );

  return parts.join("\n");
}

/**
 * Dispatch a task to a worker session.
 *
 * Flow:
 *   1. Resolve model and session key
 *   2. Build task message
 *   3. Transition label
 *   4. Fire notification (early — before session dispatch which can timeout)
 *   5. Ensure session (fire-and-forget) + send to agent
 *   6. Update worker state
 *   7. Audit
 *
 * On dispatch failure: rolls back label transition.
 * On state update failure after dispatch: logs warning (session IS running).
 */
export async function dispatchTask(
  opts: DispatchOpts,
): Promise<DispatchResult> {
  const {
    workspaceDir, agentId, project, issueId, issueTitle,
    issueDescription, issueUrl, role, level, fromLabel, toLabel,
    provider, pluginConfig, runtime,
  } = opts;

  const resolvedConfig = await loadConfig(workspaceDir, project.name);
  const resolvedRole = resolvedConfig.roles[role];
  const { timeouts } = resolvedConfig;
  const model = resolveModel(role, level, resolvedRole);
  const worker = getWorker(project, role);
  let existingSessionKey = getSessionForLevel(worker, level);

  // Context budget check: clear session if over budget (unless same issue — feedback cycle)
  if (existingSessionKey && timeouts.sessionContextBudget < 1) {
    const shouldClear = await shouldClearSession(existingSessionKey, worker, issueId, timeouts, workspaceDir, project.name);
    if (shouldClear) {
      await updateWorker(workspaceDir, project.slug, role, {
        sessions: { [level]: null },
      });
      existingSessionKey = null;
    }
  }

  const sessionAction = existingSessionKey ? "send" : "spawn";

  // Compute session key deterministically (avoids waiting for gateway)
  const sessionKey = `agent:${agentId ?? "unknown"}:subagent:${project.name}-${role}-${level}`;

  // Fetch comments to include in task context
  const comments = await provider.listComments(issueId);

  // Fetch PR context based on workflow role semantics (no hardcoded role/label checks)
  const { workflow } = resolvedConfig;
  const prFeedback = isFeedbackState(workflow, fromLabel)
    ? await fetchPrFeedback(provider, issueId) : undefined;
  const prContext = hasReviewCheck(workflow, role)
    ? await fetchPrContext(provider, issueId) : undefined;

  const taskMessage = buildTaskMessage({
    projectName: project.name, projectSlug: project.slug, role, issueId,
    issueTitle, issueDescription, issueUrl,
    repo: project.repo, baseBranch: project.baseBranch,
    comments, resolvedRole, prContext, prFeedback,
  });

  // Step 1: Transition label (this is the commitment point)
  await provider.transitionLabel(issueId, fromLabel, toLabel);

  // Step 1b: Apply role:level label (best-effort — failure must not abort dispatch)
  let issue: { labels: string[] } | undefined;
  try {
    issue = await provider.getIssue(issueId);
    const oldRoleLabels = issue.labels.filter((l) => l.startsWith(`${role}:`));
    if (oldRoleLabels.length > 0) {
      await provider.removeLabels(issueId, oldRoleLabels);
    }
    await provider.addLabel(issueId, `${role}:${level}`);

    // Step 1c: Apply review routing label when role produces reviewable work (best-effort)
    if (producesReviewableWork(workflow, role)) {
      const reviewLabel = resolveReviewRouting(
        workflow.reviewPolicy ?? ReviewPolicy.HUMAN, level,
      );
      const oldRouting = issue.labels.filter((l) => l.startsWith("review:"));
      if (oldRouting.length > 0) await provider.removeLabels(issueId, oldRouting);
      await provider.addLabel(issueId, reviewLabel);
    }
  } catch {
    // Best-effort — label failure must not abort dispatch
  }

  // Step 2: Send notification early (before session dispatch which can timeout)
  // This ensures users see the notification even if gateway is slow
  const notifyConfig = getNotificationConfig(pluginConfig);
  const notifyTarget = resolveNotifyChannel(issue?.labels ?? [], project.channels);
  notify(
    {
      type: "workerStart",
      project: project.name,
      issueId,
      issueTitle,
      issueUrl,
      role,
      level,
      sessionAction,
    },
    {
      workspaceDir,
      config: notifyConfig,
      groupId: notifyTarget?.groupId,
      channel: notifyTarget?.channel ?? "telegram",
      runtime,
    },
  ).catch((err) => {
    auditLog(workspaceDir, "dispatch_warning", {
      step: "notify", issue: issueId, role,
      error: (err as Error).message ?? String(err),
    }).catch(() => {});
  });

  // Step 3: Ensure session exists (fire-and-forget — don't wait for gateway)
  // Session key is deterministic, so we can proceed immediately
  ensureSessionFireAndForget(sessionKey, model, workspaceDir, timeouts.sessionPatchMs);

  // Step 4: Send task to agent (fire-and-forget)
  sendToAgent(sessionKey, taskMessage, {
    agentId, projectName: project.name, issueId, role, level,
    orchestratorSessionKey: opts.sessionKey, workspaceDir,
    dispatchTimeoutMs: timeouts.dispatchMs,
  });

  // Step 5: Update worker state
  try {
    await recordWorkerState(workspaceDir, project.slug, role, {
      issueId, level, sessionKey, sessionAction, fromLabel,
    });
  } catch (err) {
    // Session is already dispatched — log warning but don't fail
    await auditLog(workspaceDir, "work_start", {
      project: project.name, issue: issueId, role,
      warning: "State update failed after successful dispatch",
      error: (err as Error).message, sessionKey,
    });
  }

  // Step 6: Audit
  await auditDispatch(workspaceDir, {
    project: project.name, issueId, issueTitle,
    role, level, model, sessionAction, sessionKey,
    fromLabel, toLabel,
  });

  const announcement = buildAnnouncement(level, role, sessionAction, issueId, issueTitle, issueUrl, resolvedRole);

  return { sessionAction, sessionKey, level, model, announcement };
}

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
async function shouldClearSession(
  sessionKey: string,
  worker: import("./projects.js").WorkerState,
  newIssueId: number,
  timeouts: import("./config/types.js").ResolvedTimeouts,
  workspaceDir: string,
  projectName: string,
): Promise<boolean> {
  // Don't clear if re-dispatching for the same issue (feedback cycle)
  if (worker.issueId && String(newIssueId) === String(worker.issueId)) {
    return false;
  }

  // Check context budget via gateway session data
  try {
    const sessions = await fetchGatewaySessions();
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
function ensureSessionFireAndForget(sessionKey: string, model: string, workspaceDir: string, timeoutMs = 30_000): void {
  runCommand(
    ["openclaw", "gateway", "call", "sessions.patch", "--params", JSON.stringify({ key: sessionKey, model })],
    { timeoutMs },
  ).catch((err) => {
    auditLog(workspaceDir, "dispatch_warning", {
      step: "ensureSession", sessionKey,
      error: (err as Error).message ?? String(err),
    }).catch(() => {});
  });
}

function sendToAgent(
  sessionKey: string, taskMessage: string,
  opts: { agentId?: string; projectName: string; issueId: number; role: string; level?: string; orchestratorSessionKey?: string; workspaceDir: string; dispatchTimeoutMs?: number },
): void {
  const gatewayParams = JSON.stringify({
    idempotencyKey: `devclaw-${opts.projectName}-${opts.issueId}-${opts.role}-${opts.level ?? "unknown"}-${sessionKey}`,
    agentId: opts.agentId ?? "devclaw",
    sessionKey,
    message: taskMessage,
    deliver: false,
    lane: "subagent",
    ...(opts.orchestratorSessionKey ? { spawnedBy: opts.orchestratorSessionKey } : {}),
  });
  // Fire-and-forget: long-running agent turn, don't await
  runCommand(
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

async function recordWorkerState(
  workspaceDir: string, slug: string, role: string,
  opts: { issueId: number; level: string; sessionKey: string; sessionAction: "spawn" | "send"; fromLabel?: string },
): Promise<void> {
  await activateWorker(workspaceDir, slug, role, {
    issueId: String(opts.issueId),
    level: opts.level,
    sessionKey: opts.sessionKey,
    startTime: new Date().toISOString(),
    previousLabel: opts.fromLabel,
  });
}

async function auditDispatch(
  workspaceDir: string,
  opts: {
    project: string; issueId: number; issueTitle: string;
    role: string; level: string; model: string; sessionAction: string;
    sessionKey: string; fromLabel: string; toLabel: string;
  },
): Promise<void> {
  await auditLog(workspaceDir, "work_start", {
    project: opts.project,
    issue: opts.issueId, issueTitle: opts.issueTitle,
    role: opts.role, level: opts.level,
    sessionAction: opts.sessionAction, sessionKey: opts.sessionKey,
    labelTransition: `${opts.fromLabel} → ${opts.toLabel}`,
  });
  await auditLog(workspaceDir, "model_selection", {
    issue: opts.issueId, role: opts.role, level: opts.level, model: opts.model,
  });
}

function buildAnnouncement(
  level: string, role: string, sessionAction: "spawn" | "send",
  issueId: number, issueTitle: string, issueUrl: string,
  resolvedRole?: ResolvedRoleConfig,
): string {
  const emoji = resolvedRole?.emoji[level] ?? getFallbackEmoji(role);
  const actionVerb = sessionAction === "spawn" ? "Spawning" : "Sending";
  return `${emoji} ${actionVerb} ${role.toUpperCase()} (${level}) for #${issueId}: ${issueTitle}\n🔗 [Issue #${issueId}](${issueUrl})`;
}
