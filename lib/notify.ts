/**
 * notify.ts — Programmatic alerting for worker lifecycle events.
 *
 * Sends notifications to project groups for visibility into the DevClaw pipeline.
 *
 * Event types:
 * - workerStart: Worker spawned/resumed for a task (→ project group)
 * - workerComplete: Worker completed task (→ project group)
 * - reviewNeeded: Issue needs review — human or agent (→ project group)
 * - prMerged: PR/MR was merged into the base branch (→ project group)
 */
import { log as auditLog } from "./audit.js";
import type { PluginRuntime } from "openclaw/plugin-sdk";

/** Per-event-type toggle. All default to true — set to false to suppress. */
export type NotificationConfig = Partial<Record<NotifyEvent["type"], boolean>>;

export type NotifyEvent =
  | {
      type: "workerStart";
      project: string;
      groupId: string;
      issueId: number;
      issueTitle: string;
      issueUrl: string;
      role: string;
      level: string;
      sessionAction: "spawn" | "send";
    }
  | {
      type: "workerComplete";
      project: string;
      groupId: string;
      issueId: number;
      issueUrl: string;
      role: string;
      result: "done" | "pass" | "fail" | "refine" | "blocked";
      summary?: string;
      nextState?: string;
      prUrl?: string;
    }
  | {
      type: "reviewNeeded";
      project: string;
      groupId: string;
      issueId: number;
      issueUrl: string;
      issueTitle: string;
      routing: "human" | "agent";
      prUrl?: string;
    }
  | {
      type: "prMerged";
      project: string;
      groupId: string;
      issueId: number;
      issueUrl: string;
      issueTitle: string;
      prUrl?: string;
      prTitle?: string;
      sourceBranch?: string;
      mergedBy: "heartbeat" | "agent" | "pipeline";
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
      if (event.prUrl) msg += `\n🔗 PR: ${event.prUrl}`;
      msg += `\n📋 Issue: ${event.issueUrl}`;
      return msg;
    }

    case "reviewNeeded": {
      const icon = event.routing === "human" ? "👀" : "🤖";
      const who = event.routing === "human" ? "Human review needed" : "Agent review queued";
      let msg = `${icon} ${who} for #${event.issueId}: ${event.issueTitle}`;
      if (event.prUrl) msg += `\n🔗 PR: ${event.prUrl}`;
      msg += `\n📋 Issue: ${event.issueUrl}`;
      return msg;
    }

    case "prMerged": {
      const via: Record<string, string> = {
        heartbeat: "auto-merged after approval",
        agent: "merged by agent reviewer",
        pipeline: "merged by reviewer",
      };
      let msg = `🔀 PR merged for #${event.issueId}: ${event.issueTitle}`;
      if (event.prTitle) msg += `\n📝 ${event.prTitle}`;
      if (event.sourceBranch) msg += `\n🌿 ${event.sourceBranch} → main`;
      msg += `\n⚡ ${via[event.mergedBy] ?? event.mergedBy}`;
      if (event.prUrl) msg += `\n🔗 PR: ${event.prUrl}`;
      msg += `\n📋 Issue: ${event.issueUrl}`;
      return msg;
    }
  }
}

/**
 * Send a notification message via the plugin runtime API.
 *
 * Uses the runtime's native send functions to bypass CLI → WebSocket timeouts.
 * Falls back gracefully on error (notifications shouldn't break the main flow).
 */
async function sendMessage(
  target: string,
  message: string,
  channel: string,
  workspaceDir: string,
  runtime?: PluginRuntime,
): Promise<boolean> {
  try {
    // Use runtime API when available (avoids CLI subprocess timeouts)
    if (runtime) {
      if (channel === "telegram") {
        await runtime.channel.telegram.sendMessageTelegram(target, message, { silent: true });
        return true;
      }
      if (channel === "whatsapp") {
        await runtime.channel.whatsapp.sendMessageWhatsApp(target, message, { verbose: false });
        return true;
      }
      if (channel === "discord") {
        await runtime.channel.discord.sendMessageDiscord(target, message);
        return true;
      }
      if (channel === "slack") {
        await runtime.channel.slack.sendMessageSlack(target, message);
        return true;
      }
      if (channel === "signal") {
        await runtime.channel.signal.sendMessageSignal(target, message);
        return true;
      }
    }

    // Fallback: use CLI (for unsupported channels or when runtime isn't available)
    // Import lazily to avoid circular dependency issues
    const { runCommand } = await import("./run-command.js");
    await runCommand(
      [
        "openclaw",
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
      { timeoutMs: 30_000 },
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
 * Returns true if notification was sent, false on error.
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
    /** Plugin runtime for direct API access (avoids CLI subprocess timeouts) */
    runtime?: PluginRuntime;
  },
): Promise<boolean> {
  if (opts.config?.[event.type] === false) return true;

  const channel = opts.channel ?? "telegram";
  const message = buildMessage(event);
  const target = opts.groupId ?? (event as { groupId?: string }).groupId;

  if (!target) {
    await auditLog(opts.workspaceDir, "notify_skip", {
      eventType: event.type,
      reason: "no target",
    });
    return true; // Not an error, just nothing to do
  }

  await auditLog(opts.workspaceDir, "notify", {
    eventType: event.type,
    target,
    channel,
    message,
  });

  return sendMessage(target, message, channel, opts.workspaceDir, opts.runtime);
}

/**
 * Extract notification config from plugin config.
 * All event types default to enabled (true).
 */
export function getNotificationConfig(
  pluginConfig?: Record<string, unknown>,
): NotificationConfig {
  return (pluginConfig?.notifications as NotificationConfig) ?? {};
}
