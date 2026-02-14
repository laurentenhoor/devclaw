/**
 * dispatch.ts — Core dispatch logic shared by work_start and projectTick.
 *
 * Handles: session lookup, spawn/reuse via Gateway RPC, task dispatch via CLI,
 * state update (activateWorker), and audit logging.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { PluginRuntime } from "openclaw/plugin-sdk";
import { log as auditLog } from "./audit.js";
import { runCommand } from "./run-command.js";
import {
  type Project,
  activateWorker,
  getSessionForLevel,
  getWorker,
} from "./projects.js";
import { resolveModel, levelEmoji } from "./tiers.js";
import { notify, getNotificationConfig } from "./notify.js";

export type DispatchOpts = {
  workspaceDir: string;
  agentId?: string;
  groupId: string;
  project: Project;
  issueId: number;
  issueTitle: string;
  issueDescription: string;
  issueUrl: string;
  role: "dev" | "qa";
  /** Developer level (junior, medior, senior, reviewer) or raw model ID */
  level: string;
  /** Label to transition FROM (e.g. "To Do", "To Test", "To Improve") */
  fromLabel: string;
  /** Label to transition TO (e.g. "Doing", "Testing") */
  toLabel: string;
  /** Function to transition labels (injected to avoid provider dependency) */
  transitionLabel: (issueId: number, from: string, to: string) => Promise<void>;
  /** Issue provider for fetching comments */
  provider: import("./providers/provider.js").IssueProvider;
  /** Plugin config for model resolution and notification config */
  pluginConfig?: Record<string, unknown>;
  /** Channel for notifications (e.g. "telegram", "whatsapp") */
  channel?: string;
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
 * Reads role-specific instructions from workspace/projects/roles/<project>/<role>.md (falls back to projects/roles/default/).
 */
export async function buildTaskMessage(opts: {
  workspaceDir: string;
  projectName: string;
  role: "dev" | "qa";
  issueId: number;
  issueTitle: string;
  issueDescription: string;
  issueUrl: string;
  repo: string;
  baseBranch: string;
  groupId: string;
  comments?: Array<{ author: string; body: string; created_at: string }>;
}): Promise<string> {
  const {
    workspaceDir, projectName, role, issueId, issueTitle,
    issueDescription, issueUrl, repo, baseBranch, groupId,
  } = opts;

  const roleInstructions = await loadRoleInstructions(workspaceDir, projectName, role);

  const availableResults =
    role === "dev"
      ? '"done" (completed successfully) or "blocked" (cannot complete, need help)'
      : '"pass" (approved), "fail" (issues found), "refine" (needs human input), or "blocked" (cannot complete)';

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

  parts.push(
    ``,
    `Repo: ${repo} | Branch: ${baseBranch} | ${issueUrl}`,
    `Project group ID: ${groupId}`,
  );

  if (roleInstructions) {
    parts.push(``, `---`, ``, roleInstructions.trim());
  }

  parts.push(
    ``, `---`, ``,
    `## MANDATORY: Task Completion`,
    ``,
    `When you finish this task, you MUST call \`work_finish\` with:`,
    `- \`role\`: "${role}"`,
    `- \`projectGroupId\`: "${groupId}"`,
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
    workspaceDir, agentId, groupId, project, issueId, issueTitle,
    issueDescription, issueUrl, role, level, fromLabel, toLabel,
    transitionLabel, provider, pluginConfig, runtime,
  } = opts;

  const model = resolveModel(role, level, pluginConfig);
  const worker = getWorker(project, role);
  const existingSessionKey = getSessionForLevel(worker, level);
  const sessionAction = existingSessionKey ? "send" : "spawn";

  // Compute session key deterministically (avoids waiting for gateway)
  const sessionKey = `agent:${agentId ?? "unknown"}:subagent:${project.name}-${role}-${level}`;

  // Fetch comments to include in task context
  const comments = await provider.listComments(issueId);

  const taskMessage = await buildTaskMessage({
    workspaceDir, projectName: project.name, role, issueId,
    issueTitle, issueDescription, issueUrl,
    repo: project.repo, baseBranch: project.baseBranch, groupId,
    comments,
  });

  // Step 1: Transition label (this is the commitment point)
  await transitionLabel(issueId, fromLabel, toLabel);

  // Step 2: Send notification early (before session dispatch which can timeout)
  // This ensures users see the notification even if gateway is slow
  const notifyConfig = getNotificationConfig(pluginConfig);
  notify(
    {
      type: "workerStart",
      project: project.name,
      groupId,
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
      groupId,
      channel: opts.channel ?? "telegram",
      runtime,
    },
  ).catch(() => { /* non-fatal */ });

  // Step 3: Ensure session exists (fire-and-forget — don't wait for gateway)
  // Session key is deterministic, so we can proceed immediately
  ensureSessionFireAndForget(sessionKey, model);

  // Step 4: Send task to agent (fire-and-forget)
  sendToAgent(sessionKey, taskMessage, {
    agentId, projectName: project.name, issueId, role,
    orchestratorSessionKey: opts.sessionKey,
  });

  // Step 5: Update worker state
  try {
    await recordWorkerState(workspaceDir, groupId, role, {
      issueId, level, sessionKey, sessionAction,
    });
  } catch (err) {
    // Session is already dispatched — log warning but don't fail
    await auditLog(workspaceDir, "work_start", {
      project: project.name, groupId, issue: issueId, role,
      warning: "State update failed after successful dispatch",
      error: (err as Error).message, sessionKey,
    });
  }

  // Step 6: Audit
  await auditDispatch(workspaceDir, {
    project: project.name, groupId, issueId, issueTitle,
    role, level, model, sessionAction, sessionKey,
    fromLabel, toLabel,
  });

  const announcement = buildAnnouncement(level, role, sessionAction, issueId, issueTitle, issueUrl);

  return { sessionAction, sessionKey, level, model, announcement };
}

// ---------------------------------------------------------------------------
// Private helpers — exist so dispatchTask reads as a sequence of steps
// ---------------------------------------------------------------------------

/**
 * Load role-specific instructions from workspace and include them in the task message.
 * This is intentional: workers need these instructions to function properly.
 * (Not data exfiltration — just standard task dispatch context.)
 */
async function loadRoleInstructions(
  workspaceDir: string, projectName: string, role: "dev" | "qa",
): Promise<string> {
  const projectFile = path.join(workspaceDir, "projects", "roles", projectName, `${role}.md`);
  try { return await fs.readFile(projectFile, "utf-8"); } catch { /* none */ }
  const defaultFile = path.join(workspaceDir, "projects", "roles", "default", `${role}.md`);
  try { return await fs.readFile(defaultFile, "utf-8"); } catch { /* none */ }
  return "";
}

/**
 * Fire-and-forget session creation/update.
 * Session key is deterministic, so we don't need to wait for confirmation.
 * If this fails, health check will catch orphaned state later.
 */
function ensureSessionFireAndForget(sessionKey: string, model: string): void {
  runCommand(
    ["openclaw", "gateway", "call", "sessions.patch", "--params", JSON.stringify({ key: sessionKey, model })],
    { timeoutMs: 30_000 },
  ).catch(() => { /* fire-and-forget */ });
}

function sendToAgent(
  sessionKey: string, taskMessage: string,
  opts: { agentId?: string; projectName: string; issueId: number; role: string; orchestratorSessionKey?: string },
): void {
  const gatewayParams = JSON.stringify({
    idempotencyKey: `devclaw-${opts.projectName}-${opts.issueId}-${opts.role}-${Date.now()}`,
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
    { timeoutMs: 600_000 },
  ).catch(() => { /* fire-and-forget */ });
}

async function recordWorkerState(
  workspaceDir: string, groupId: string, role: "dev" | "qa",
  opts: { issueId: number; level: string; sessionKey: string; sessionAction: "spawn" | "send" },
): Promise<void> {
  await activateWorker(workspaceDir, groupId, role, {
    issueId: String(opts.issueId),
    level: opts.level,
    sessionKey: opts.sessionKey,
    startTime: new Date().toISOString(),
  });
}

async function auditDispatch(
  workspaceDir: string,
  opts: {
    project: string; groupId: string; issueId: number; issueTitle: string;
    role: string; level: string; model: string; sessionAction: string;
    sessionKey: string; fromLabel: string; toLabel: string;
  },
): Promise<void> {
  await auditLog(workspaceDir, "work_start", {
    project: opts.project, groupId: opts.groupId,
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
): string {
  const emoji = levelEmoji(role as "dev" | "qa", level) ?? (role === "qa" ? "🔍" : "🔧");
  const actionVerb = sessionAction === "spawn" ? "Spawning" : "Sending";
  return `${emoji} ${actionVerb} ${role.toUpperCase()} (${level}) for #${issueId}: ${issueTitle}\n🔗 ${issueUrl}`;
}
