/**
 * notify.ts — Programmatic alerting for worker lifecycle events.
 *
 * Sends notifications to project groups and orchestrator DM for visibility
 * into the DevClaw pipeline.
 *
 * Event types:
 * - workerStart: Worker spawned/resumed for a task (→ project group)
 * - workerComplete: Worker completed task (→ project group)
 * - heartbeat: Heartbeat tick summary (→ orchestrator DM)
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log as auditLog } from "./audit.js";
import type { TickAction } from "./services/tick.js";

const execFileAsync = promisify(execFile);

export type NotificationConfig = {
  /** Send heartbeat summaries to orchestrator DM. Default: true */
  heartbeatDm?: boolean;
  /** Post when worker starts a task. Default: true */
  workerStart?: boolean;
  /** Post when worker completes a task. Default: true */
  workerComplete?: boolean;
};

export type NotifyEvent =
  | {
      type: "workerStart";
      project: string;
      groupId: string;
      issueId: number;
      issueTitle: string;
      issueUrl: string;
      role: "dev" | "qa";
      level: string;
      sessionAction: "spawn" | "send";
    }
  | {
      type: "workerComplete";
      project: string;
      groupId: string;
      issueId: number;
      issueUrl: string;
      role: "dev" | "qa";
      result: "done" | "pass" | "fail" | "refine" | "blocked";
      summary?: string;
      nextState?: string;
    }
  | {
      type: "heartbeat";
      projectsScanned: number;
      healthFixes: number;
      pickups: number;
      skipped: number;
      dryRun: boolean;
      pickupDetails?: Array<{
        project: string;
        issueId: number;
        role: "dev" | "qa";
      }>;
    };

/**
 * Build a human-readable message for a notification event.
 */
function buildMessage(event: NotifyEvent): string {
  switch (event.type) {
    case "workerStart": {
      const action = event.sessionAction === "spawn" ? "🚀 Started" : "▶️ Resumed";
      return `${action} ${event.role.toUpperCase()} (${event.level}) on #${event.issueId}: ${event.issueTitle}\n🔗 ${event.issueUrl}`;
    }

    case "workerComplete": {
      const icons: Record<string, string> = {
        done: "✅",
        pass: "🎉",
        fail: "❌",
        refine: "🤔",
        blocked: "🚫",
      };
      const icon = icons[event.result] ?? "📋";
      const resultText: Record<string, string> = {
        done: "completed",
        pass: "PASSED",
        fail: "FAILED",
        refine: "needs refinement",
        blocked: "BLOCKED",
      };
      const text = resultText[event.result] ?? event.result;
      let msg = `${icon} ${event.role.toUpperCase()} ${text} #${event.issueId}`;
      if (event.summary) {
        msg += ` — ${event.summary}`;
      }
      if (event.nextState) {
        msg += ` → ${event.nextState}`;
      }
      msg += `\n🔗 ${event.issueUrl}`;
      return msg;
    }

    case "heartbeat": {
      if (event.dryRun) {
        return `🔄 Heartbeat (dry run): scanned ${event.projectsScanned} projects, would pick up ${event.pickups} tasks`;
      }
      const parts = [`🔄 Heartbeat: scanned ${event.projectsScanned} projects`];
      if (event.healthFixes > 0) {
        parts.push(`fixed ${event.healthFixes} zombie(s)`);
      }
      if (event.pickups > 0) {
        parts.push(`spawned ${event.pickups} worker(s)`);
        if (event.pickupDetails && event.pickupDetails.length > 0) {
          const details = event.pickupDetails
            .map((p) => `${p.project}#${p.issueId}(${p.role})`)
            .join(", ");
          parts.push(`[${details}]`);
        }
      }
      if (event.pickups === 0 && event.healthFixes === 0) {
        parts.push("no actions needed");
      }
      return parts.join(", ");
    }
  }
}

/**
 * Send a notification message via the native OpenClaw messaging CLI.
 *
 * Uses `openclaw message send` which handles target resolution, chunking,
 * retries, and error reporting for all supported channels.
 * Fails silently (logs error but doesn't throw) to avoid breaking the main flow.
 */
async function sendMessage(
  target: string,
  message: string,
  channel: string,
  workspaceDir: string,
): Promise<boolean> {
  try {
    await execFileAsync(
      "openclaw",
      [
        "message",
        "send",
        "--channel",
        channel,
        "--target",
        target,
        "--message",
        message,
        "--json",
      ],
      { timeout: 30_000 },
    );
    return true;
  } catch (err) {
    // Log but don't throw — notifications shouldn't break the main flow
    await auditLog(workspaceDir, "notify_error", {
      target,
      channel,
      error: (err as Error).message,
    });
    return false;
  }
}

/**
 * Send a notification for a worker lifecycle event.
 *
 * Respects notification config settings.
 * Returns true if notification was sent (or skipped due to config), false on error.
 */
export async function notify(
  event: NotifyEvent,
  opts: {
    workspaceDir: string;
    config?: NotificationConfig;
    /** Target for project-scoped notifications (groupId) */
    groupId?: string;
    /** Channel type for routing (e.g. "telegram", "whatsapp", "discord", "slack") */
    channel?: string;
    /** Target for DM notifications (orchestrator) */
    orchestratorDm?: string;
  },
): Promise<boolean> {
  const config = opts.config ?? {};
  const channel = opts.channel ?? "telegram";

  // Check if notification is enabled
  if (event.type === "workerStart" && config.workerStart === false) {
    return true; // Skipped, not an error
  }
  if (event.type === "workerComplete" && config.workerComplete === false) {
    return true;
  }
  if (event.type === "heartbeat" && config.heartbeatDm === false) {
    return true;
  }

  const message = buildMessage(event);

  // Determine target
  let target: string | undefined;
  if (event.type === "heartbeat") {
    target = opts.orchestratorDm;
  } else {
    target = opts.groupId ?? (event as { groupId?: string }).groupId;
  }

  if (!target) {
    // No target specified, can't send
    await auditLog(opts.workspaceDir, "notify_skip", {
      eventType: event.type,
      reason: "no target",
    });
    return true; // Not an error, just nothing to do
  }

  // Audit the notification attempt
  await auditLog(opts.workspaceDir, "notify", {
    eventType: event.type,
    target,
    channel,
    message,
  });

  return sendMessage(target, message, channel, opts.workspaceDir);
}

/**
 * Send workerStart notifications for each tick pickup.
 *
 * Called after projectTick() returns pickups — callers pass the array
 * so each dispatched task gets a visible start notification in the project group.
 */
export async function notifyTickPickups(
  pickups: TickAction[],
  opts: {
    workspaceDir: string;
    config?: NotificationConfig;
    channel?: string;
  },
): Promise<void> {
  for (const pickup of pickups) {
    await notify(
      {
        type: "workerStart",
        project: pickup.project,
        groupId: pickup.groupId,
        issueId: pickup.issueId,
        issueTitle: pickup.issueTitle,
        issueUrl: pickup.issueUrl,
        role: pickup.role,
        level: pickup.level,
        sessionAction: pickup.sessionAction,
      },
      {
        workspaceDir: opts.workspaceDir,
        config: opts.config,
        groupId: pickup.groupId,
        channel: opts.channel,
      },
    );
  }
}

/**
 * Get notification config from plugin config.
 */
export function getNotificationConfig(
  pluginConfig?: Record<string, unknown>,
): NotificationConfig {
  const notifications = pluginConfig?.notifications as NotificationConfig | undefined;
  return {
    heartbeatDm: notifications?.heartbeatDm ?? true,
    workerStart: notifications?.workerStart ?? true,
    workerComplete: notifications?.workerComplete ?? true,
  };
}
