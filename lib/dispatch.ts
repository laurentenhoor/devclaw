/**
 * dispatch.ts — Core dispatch logic shared by work_start and projectTick.
 *
 * Handles: session lookup, spawn/reuse via Gateway RPC, task dispatch via CLI,
 * state update (activateWorker), and audit logging.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { log as auditLog } from "./audit.js";
import { runCommand } from "./run-command.js";
import {
  type Project,
  activateWorker,
  getSessionForLevel,
  getWorker,
} from "./projects.js";
import { resolveModel, levelEmoji } from "./tiers.js";

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
  /** Plugin config for model resolution */
  pluginConfig?: Record<string, unknown>;
  /** Orchestrator's session key (used as spawnedBy for subagent tracking) */
  sessionKey?: string;
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
    ``,
    `Repo: ${repo} | Branch: ${baseBranch} | ${issueUrl}`,
    `Project group ID: ${groupId}`,
  ];

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
 * Flow: resolve model → build message → transition label → spawn/send session
 *       → update worker state → audit → build announcement.
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
    transitionLabel, pluginConfig,
  } = opts;

  const model = resolveModel(role, level, pluginConfig);
  const worker = getWorker(project, role);
  const existingSessionKey = getSessionForLevel(worker, level);
  const sessionAction = existingSessionKey ? "send" : "spawn";

  const taskMessage = await buildTaskMessage({
    workspaceDir, projectName: project.name, role, issueId,
    issueTitle, issueDescription, issueUrl,
    repo: project.repo, baseBranch: project.baseBranch, groupId,
  });

  await transitionLabel(issueId, fromLabel, toLabel);

  let dispatched = false;
  let session: { key: string; action: "spawn" | "send" };

  try {
    session = await ensureSession(sessionAction, existingSessionKey, {
      agentId, projectName: project.name, role, level, model,
    });

    sendToAgent(session.key, taskMessage, {
      agentId, projectName: project.name, issueId, role,
      orchestratorSessionKey: opts.sessionKey,
    });

    dispatched = true;

    // Always store session key — a "send" may have fallen back to "spawn"
    await recordWorkerState(workspaceDir, groupId, role, {
      issueId, level, sessionKey: session.key, sessionAction: session.action,
    });
  } catch (err) {
    if (dispatched) {
      await auditLog(workspaceDir, "work_start", {
        project: project.name, groupId, issue: issueId, role,
        warning: "State update failed after successful dispatch",
        error: (err as Error).message, sessionKey: session!.key,
      });
      throw new Error(
        `State update failed after successful session dispatch: ${(err as Error).message}. Session is running but projects.json was not updated.`,
      );
    }
    try { await transitionLabel(issueId, toLabel, fromLabel); } catch { /* best-effort rollback */ }
    throw new Error(
      `Session dispatch failed: ${(err as Error).message}. Label reverted to "${fromLabel}".`,
    );
  }

  await auditDispatch(workspaceDir, {
    project: project.name, groupId, issueId, issueTitle,
    role, level, model, sessionAction: session.action, sessionKey: session.key,
    fromLabel, toLabel,
  });

  const announcement = buildAnnouncement(level, role, session.action, issueId, issueTitle, issueUrl);

  return { sessionAction: session.action, sessionKey: session.key, level, model, announcement };
}

// ---------------------------------------------------------------------------
// Private helpers — exist so dispatchTask reads as a sequence of steps
// ---------------------------------------------------------------------------

async function loadRoleInstructions(
  workspaceDir: string, projectName: string, role: "dev" | "qa",
): Promise<string> {
  const projectFile = path.join(workspaceDir, "projects", "roles", projectName, `${role}.md`);
  try { return await fs.readFile(projectFile, "utf-8"); } catch { /* none */ }
  const defaultFile = path.join(workspaceDir, "projects", "roles", "default", `${role}.md`);
  try { return await fs.readFile(defaultFile, "utf-8"); } catch { /* none */ }
  return "";
}

async function ensureSession(
  action: "spawn" | "send",
  existingKey: string | null,
  opts: { agentId?: string; projectName: string; role: string; level: string; model: string },
): Promise<{ key: string; action: "spawn" | "send" }> {
  const expectedKey = `agent:${opts.agentId ?? "unknown"}:subagent:${opts.projectName}-${opts.role}-${opts.level}`;

  // Reuse: validate stored key matches expected format, then verify session exists
  if (action === "send" && existingKey === expectedKey) {
    try {
      await runCommand(
        ["openclaw", "gateway", "call", "sessions.patch", "--params", JSON.stringify({ key: existingKey, model: opts.model })],
        { timeoutMs: 30_000 },
      );
      return { key: existingKey, action: "send" };
    } catch {
      // Session gone (deleted, cleanup, etc.) — fall through to spawn
    }
  }

  // Spawn: create fresh session (also handles stale/mismatched keys)
  await runCommand(
    ["openclaw", "gateway", "call", "sessions.patch", "--params", JSON.stringify({ key: expectedKey, model: opts.model })],
    { timeoutMs: 30_000 },
  );
  return { key: expectedKey, action: "spawn" };
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
