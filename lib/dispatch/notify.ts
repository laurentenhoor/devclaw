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
import { log as auditLog } from "../audit.js";
import type { PluginRuntime } from "openclaw/plugin-sdk";
import type { RunCommand } from "../context.js";

/** Per-event-type toggle. All default to true — set to false to suppress. */
export type NotificationConfig = Partial<Record<NotifyEvent["type"], boolean>>;

export type NotifyEvent =
  | {
      type: "workerStart";
      project: string;
      issueId: number;
      issueTitle: string;
      issueUrl: string;
      role: string;
      level: string;
      name?: string;
      sessionAction: "spawn" | "send";
    }
  | {
      type: "workerComplete";
      project: string;
      issueId: number;
      issueUrl: string;
      role: string;
      level?: string;
      name?: string;
      result: "done" | "pass" | "fail" | "refine" | "blocked";
      summary?: string;
      nextState?: string;
      prUrl?: string;
      createdTasks?: Array<{ id: number; title: string; url: string }>;
    }
  | {
      type: "reviewNeeded";
      project: string;
      issueId: number;
      issueUrl: string;
      issueTitle: string;
      routing: "human" | "agent";
      prUrl?: string;
    }
  | {
      type: "prMerged";
      project: string;
      issueId: number;
      issueUrl: string;
      issueTitle: string;
      prUrl?: string;
      prTitle?: string;
      sourceBranch?: string;
      mergedBy: "heartbeat" | "agent" | "pipeline";
    }
  | {
      type: "changesRequested";
      project: string;
      issueId: number;
      issueUrl: string;
      issueTitle: string;
      prUrl?: string;
    }
  | {
      type: "mergeConflict";
      project: string;
      issueId: number;
      issueUrl: string;
      issueTitle: string;
      prUrl?: string;
    }
  | {
      type: "prClosed";
      project: string;
      issueId: number;
      issueUrl: string;
      issueTitle: string;
      prUrl?: string;
    };

/**
 * Format a worker identification string in a standardized format.
 *
 * Combines role, worker name, and level into a consistent format:
 * - "DEVELOPER" (no name/level)
 * - "DEVELOPER Herminia" (name only)
 * - "DEVELOPER (junior)" (level only)
 * - "DEVELOPER Herminia (junior)" (name and level)
 *
 * This ensures consistency across all notifications that reference a worker.
 */
function formatWorkerString(
  role: string,
  opts?: { name?: string; level?: string },
): string {
  const roleUpper = role.toUpperCase();
  const parts = [roleUpper];

  if (opts?.name) {
    parts.push(opts.name);
  }

  if (opts?.level) {
    parts.push(`(${opts.level})`);
  }

  return parts.join(" ");
}

/**
 * Extract a PR/MR number from a URL.
 * GitHub: .../pull/123  GitLab: .../merge_requests/123
 * Returns null if not parseable.
 */
function extractPrNumber(url: string): number | null {
  const m = url.match(/\/(?:pull|merge_requests)\/(\d+)/);
  return m ? Number(m[1]) : null;
}

/**
 * Format a PR/MR link with a descriptive label including the PR number.
 * Example: [Pull Request #253](url) or [Merge Request #253](url)
 */
function prLink(url: string): string {
  const num = extractPrNumber(url);
  const isGitLab = url.includes("merge_requests");
  const label = isGitLab
    ? `Merge Request${num != null ? ` #${num}` : ""}`
    : `Pull Request${num != null ? ` #${num}` : ""}`;
  return `[${label}](${url})`;
}

/**
 * Build a human-readable message for a notification event.
 */
function buildMessage(event: NotifyEvent): string {
  switch (event.type) {
    case "workerStart": {
      const action = event.sessionAction === "spawn" ? "🚀 Started" : "▶️ Resumed";
      const worker = formatWorkerString(event.role, {
        name: event.name,
        level: event.level,
      });
      return `${action} ${worker} on #${event.issueId}: ${event.issueTitle}\n🔗 [Issue #${event.issueId}](${event.issueUrl})`;
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
      // Header: status + issue reference
      const worker = formatWorkerString(event.role, {
        name: event.name,
        level: event.level,
      });
      let msg = `${icon} ${worker} ${text} #${event.issueId}`;
      // Summary: on its own line for readability
      if (event.summary) {
        msg += `\n${event.summary}`;
      }
      // Links: PR and issue on separate lines
      if (event.prUrl) msg += `\n🔗 ${prLink(event.prUrl)}`;
      msg += `\n📋 [Issue #${event.issueId}](${event.issueUrl})`;
      // Created tasks (e.g. architect implementation tasks)
      if (event.createdTasks && event.createdTasks.length > 0) {
        msg += `\n📌 Created tasks:`;
        for (const t of event.createdTasks) {
          msg += `\n  · [#${t.id}: ${t.title}](${t.url})`;
        }
        msg += `\nReply to start working on them.`;
      }
      // Workflow transition: at the end
      if (event.nextState) {
        msg += `\n→ ${event.nextState}`;
      }
      return msg;
    }

    case "reviewNeeded": {
      const icon = event.routing === "human" ? "👀" : "🤖";
      const who = event.routing === "human" ? "Human review needed" : "Agent review queued";
      let msg = `${icon} ${who} for #${event.issueId}: ${event.issueTitle}`;
      if (event.prUrl) msg += `\n🔗 ${prLink(event.prUrl)}`;
      msg += `\n📋 [Issue #${event.issueId}](${event.issueUrl})`;
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
      if (event.prUrl) msg += `\n🔗 ${prLink(event.prUrl)}`;
      msg += `\n📋 [Issue #${event.issueId}](${event.issueUrl})`;
      return msg;
    }

    case "changesRequested": {
      let msg = `⚠️ Changes requested on PR for #${event.issueId}: ${event.issueTitle}`;
      if (event.prUrl) msg += `\n🔗 ${prLink(event.prUrl)}`;
      msg += `\n📋 [Issue #${event.issueId}](${event.issueUrl})`;
      msg += `\n→ Moving to To Improve for developer re-dispatch`;
      return msg;
    }

    case "mergeConflict": {
      let msg = `⚠️ Merge conflicts detected on PR for #${event.issueId}: ${event.issueTitle}`;
      if (event.prUrl) msg += `\n🔗 ${prLink(event.prUrl)}`;
      msg += `\n📋 [Issue #${event.issueId}](${event.issueUrl})`;
      msg += `\n→ Moving to To Improve — developer will rebase and resolve`;
      return msg;
    }

    case "prClosed": {
      let msg = `🚫 PR closed without merging for #${event.issueId}: ${event.issueTitle}`;
      if (event.prUrl) msg += `\n🔗 ${prLink(event.prUrl)}`;
      msg += `\n📋 [Issue #${event.issueId}](${event.issueUrl})`;
      msg += `\n→ Moving to To Improve for developer attention`;
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
  accountId?: string,
  runCommand?: RunCommand,
  messageThreadId?: number,
): Promise<boolean> {
  try {
    // Use runtime API when available (avoids CLI subprocess timeouts)
    if (runtime) {
      if (channel === "telegram") {
        // Cast to any to bypass TypeScript type limitation; disableWebPagePreview and messageThreadId are valid in Telegram API
        const telegramOpts: Record<string, unknown> = { silent: true, disableWebPagePreview: true, accountId };
        if (messageThreadId != null) telegramOpts.messageThreadId = messageThreadId;
        await runtime.channel.telegram.sendMessageTelegram(target, message, telegramOpts as any);
        return true;
      }
      if (channel === "whatsapp") {
        await runtime.channel.whatsapp.sendMessageWhatsApp(target, message, { verbose: false, accountId });
        return true;
      }
      if (channel === "discord") {
        await runtime.channel.discord.sendMessageDiscord(target, message, { accountId });
        return true;
      }
      if (channel === "slack") {
        await runtime.channel.slack.sendMessageSlack(target, message, { accountId });
        return true;
      }
      if (channel === "signal") {
        await runtime.channel.signal.sendMessageSignal(target, message, { accountId });
        return true;
      }
    }

    // Fallback: use CLI (for unsupported channels or when runtime isn't available)
    if (!runCommand) throw new Error("runCommand is required when runtime is not available");
    const rc = runCommand;
    // Note: openclaw message send CLI doesn't expose disable_web_page_preview flag.
    // The runtime API path (above) handles it; CLI fallback won't suppress previews.
    await rc(
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
    /** Target for project-scoped notifications (channelId) */
    channelId?: string;
    /** Channel type for routing (e.g. "telegram", "whatsapp", "discord", "slack") */
    channel?: string;
    /** Plugin runtime for direct API access (avoids CLI subprocess timeouts) */
    runtime?: PluginRuntime;
    /** Optional account ID for multi-account setups */
    accountId?: string;
    /** Injected runCommand for dependency injection. */
    runCommand?: RunCommand;
    /** Optional Telegram forum topic ID for per-topic routing */
    messageThreadId?: number;
  },
): Promise<boolean> {
  if (opts.config?.[event.type] === false) return true;

  const channel = opts.channel ?? "telegram";
  const message = buildMessage(event);
  const target = opts.channelId;

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

  return sendMessage(target, message, channel, opts.workspaceDir, opts.runtime, opts.accountId, opts.runCommand, opts.messageThreadId);
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
