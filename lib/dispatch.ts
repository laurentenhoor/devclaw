/**
 * dispatch.ts — Core dispatch logic shared by work_start, auto_pickup, and projectTick.
 *
 * Handles: session lookup, spawn/reuse via Gateway RPC, task dispatch via CLI,
 * state update (activateWorker), and audit logging.
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { log as auditLog } from "./audit.js";
import {
  type Project,
  activateWorker,
  getSessionForModel,
  getWorker,
} from "./projects.js";
import { TIER_EMOJI, isTier, resolveModel } from "./tiers.js";

const execFileAsync = promisify(execFile);

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
  /** Developer tier (junior, medior, senior, qa) or raw model ID */
  modelAlias: string;
  /** Label to transition FROM (e.g. "To Do", "To Test", "To Improve") */
  fromLabel: string;
  /** Label to transition TO (e.g. "Doing", "Testing") */
  toLabel: string;
  /** Function to transition labels (injected to avoid gitlab.ts dependency) */
  transitionLabel: (issueId: number, from: string, to: string) => Promise<void>;
  /** Plugin config for model resolution */
  pluginConfig?: Record<string, unknown>;
  /** Orchestrator's session key (used as spawnedBy for subagent tracking) */
  sessionKey?: string;
};

export type DispatchResult = {
  sessionAction: "spawn" | "send";
  sessionKey: string;
  modelAlias: string;
  fullModel: string;
  announcement: string;
};

/**
 * Build the task message sent to a worker session.
 * Reads role-specific instructions from workspace/roles/<project>/<role>.md
 * with fallback to workspace/roles/default/<role>.md.
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
    workspaceDir,
    projectName,
    role,
    issueId,
    issueTitle,
    issueDescription,
    issueUrl,
    repo,
    baseBranch,
    groupId,
  } = opts;

  // Read role-specific instructions
  let roleInstructions = "";
  const projectRoleFile = path.join(
    workspaceDir,
    "roles",
    projectName,
    `${role}.md`,
  );
  const defaultRoleFile = path.join(
    workspaceDir,
    "roles",
    "default",
    `${role}.md`,
  );
  try {
    roleInstructions = await fs.readFile(projectRoleFile, "utf-8");
  } catch {
    try {
      roleInstructions = await fs.readFile(defaultRoleFile, "utf-8");
    } catch {
      // No role instructions — that's fine
    }
  }

  // Build available results based on role
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

  // Mandatory completion contract
  parts.push(
    ``,
    `---`,
    ``,
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
 * Dispatch a task to a worker session. Handles session spawn/reuse,
 * CLI dispatch, state update, and audit logging.
 *
 * Returns dispatch result on success. Throws on dispatch failure
 * (with label rollback). Logs warning on state update failure
 * (dispatch succeeded, session IS running).
 */
export async function dispatchTask(
  opts: DispatchOpts,
): Promise<DispatchResult> {
  const {
    workspaceDir,
    agentId,
    groupId,
    project,
    issueId,
    issueTitle,
    issueDescription,
    issueUrl,
    role,
    modelAlias,
    fromLabel,
    toLabel,
    transitionLabel,
    pluginConfig,
  } = opts;

  const fullModel = resolveModel(modelAlias, pluginConfig);
  const worker = getWorker(project, role);
  const existingSessionKey = getSessionForModel(worker, modelAlias);
  const sessionAction = existingSessionKey ? "send" : "spawn";

  // Build task message with role instructions
  const taskMessage = await buildTaskMessage({
    workspaceDir,
    projectName: project.name,
    role,
    issueId,
    issueTitle,
    issueDescription,
    issueUrl,
    repo: project.repo,
    baseBranch: project.baseBranch,
    groupId,
  });

  // Transition label
  await transitionLabel(issueId, fromLabel, toLabel);

  // Dispatch
  let sessionKey = existingSessionKey;
  let dispatched = false;

  try {
    if (sessionAction === "spawn") {
      sessionKey = `agent:${agentId ?? "unknown"}:subagent:${project.name}-${role}-${modelAlias}`;
      await execFileAsync(
        "openclaw",
        [
          "gateway",
          "call",
          "sessions.patch",
          "--params",
          JSON.stringify({ key: sessionKey, model: fullModel }),
        ],
        { timeout: 30_000 },
      );
    }

    // Dispatch via `gateway call agent --expect-final` as a detached background process.
    // Without --expect-final the gateway accepts but never processes the request.
    // Running with --expect-final in a detached process ensures the agent runs
    // while work_start returns immediately.
    // Using the gateway RPC (not `openclaw agent` CLI) lets us set lane, spawnedBy,
    // and deliver — matching the official sessions_spawn internals.
    const orchestratorSessionKey = opts.sessionKey;
    const gatewayParams = JSON.stringify({
      idempotencyKey: `devclaw-${project.name}-${issueId}-${role}-${Date.now()}`,
      agentId: agentId ?? "devclaw",
      sessionKey: sessionKey!,
      message: taskMessage,
      deliver: false,
      lane: "subagent",
      ...(orchestratorSessionKey
        ? { spawnedBy: orchestratorSessionKey }
        : {}),
    });
    const child = spawn(
      "openclaw",
      [
        "gateway",
        "call",
        "agent",
        "--params",
        gatewayParams,
        "--expect-final",
        "--json",
      ],
      { detached: true, stdio: "ignore" },
    );
    child.unref();

    dispatched = true;

    // Update state
    const now = new Date().toISOString();
    if (sessionAction === "spawn") {
      await activateWorker(workspaceDir, groupId, role, {
        issueId: String(issueId),
        model: modelAlias,
        sessionKey: sessionKey!,
        startTime: now,
      });
    } else {
      await activateWorker(workspaceDir, groupId, role, {
        issueId: String(issueId),
        model: modelAlias,
      });
    }
  } catch (err) {
    if (dispatched) {
      // State update failed but session IS running — log warning, don't rollback
      await auditLog(workspaceDir, "work_start", {
        project: project.name,
        groupId,
        issue: issueId,
        role,
        warning: "State update failed after successful dispatch",
        error: (err as Error).message,
        sessionKey,
      });
      // Re-throw so caller knows state update failed
      throw new Error(
        `State update failed after successful session dispatch: ${(err as Error).message}. Session is running but projects.json was not updated.`,
      );
    } else {
      // Dispatch failed — rollback label
      try {
        await transitionLabel(issueId, toLabel, fromLabel);
      } catch {
        // Best-effort rollback
      }
      throw new Error(
        `Session dispatch failed: ${(err as Error).message}. Label reverted to "${fromLabel}".`,
      );
    }
  }

  // Audit
  await auditLog(workspaceDir, "work_start", {
    project: project.name,
    groupId,
    issue: issueId,
    issueTitle,
    role,
    tier: modelAlias,
    sessionAction,
    sessionKey,
    labelTransition: `${fromLabel} → ${toLabel}`,
  });

  await auditLog(workspaceDir, "model_selection", {
    issue: issueId,
    role,
    tier: modelAlias,
    fullModel,
  });

  // Build announcement
  const emoji = isTier(modelAlias)
    ? TIER_EMOJI[modelAlias]
    : role === "qa"
      ? "🔍"
      : "🔧";
  const actionVerb = sessionAction === "spawn" ? "Spawning" : "Sending";
  const announcement = `${emoji} ${actionVerb} ${role.toUpperCase()} (${modelAlias}) for #${issueId}: ${issueTitle}\n🔗 ${issueUrl}`;

  return {
    sessionAction,
    sessionKey: sessionKey!,
    modelAlias,
    fullModel,
    announcement,
  };
}
