/**
 * Pipeline service — declarative completion rules.
 *
 * Replaces 7 if-blocks with a data-driven lookup table.
 */
import type { PluginRuntime } from "openclaw/plugin-sdk";
import type { StateLabel, IssueProvider } from "../providers/provider.js";
import { deactivateWorker } from "../projects.js";
import { runCommand } from "../run-command.js";
import { notify, getNotificationConfig } from "../notify.js";

export type CompletionRule = {
  from: StateLabel;
  to: StateLabel;
  gitPull?: boolean;
  detectPr?: boolean;
  closeIssue?: boolean;
  reopenIssue?: boolean;
};

export const COMPLETION_RULES: Record<string, CompletionRule> = {
  "dev:done":    { from: "Doing",   to: "To Test",    gitPull: true, detectPr: true },
  "qa:pass":     { from: "Testing", to: "Done",       closeIssue: true },
  "qa:fail":     { from: "Testing", to: "To Improve", reopenIssue: true },
  "qa:refine":   { from: "Testing", to: "Refining" },
  "dev:blocked": { from: "Doing",   to: "Refining" },
  "qa:blocked":  { from: "Testing", to: "Refining" },
};

export const NEXT_STATE: Record<string, string> = {
  "dev:done":    "QA queue",
  "dev:blocked": "moved to Refining - needs human input",
  "qa:pass":     "Done!",
  "qa:fail":     "back to DEV",
  "qa:refine":   "awaiting human decision",
  "qa:blocked":  "moved to Refining - needs human input",
};

const EMOJI: Record<string, string> = {
  "dev:done":    "✅",
  "qa:pass":     "🎉",
  "qa:fail":     "❌",
  "qa:refine":   "🤔",
  "dev:blocked": "🚫",
  "qa:blocked":  "🚫",
};

export type CompletionOutput = {
  labelTransition: string;
  announcement: string;
  nextState: string;
  prUrl?: string;
  issueUrl?: string;
  issueClosed?: boolean;
  issueReopened?: boolean;
};

export function getRule(role: string, result: string): CompletionRule | undefined {
  return COMPLETION_RULES[`${role}:${result}`];
}

/**
 * Execute the completion side-effects for a role:result pair.
 */
export async function executeCompletion(opts: {
  workspaceDir: string;
  groupId: string;
  role: "dev" | "qa";
  result: string;
  issueId: number;
  summary?: string;
  prUrl?: string;
  provider: IssueProvider;
  repoPath: string;
  projectName: string;
  channel?: string;
  pluginConfig?: Record<string, unknown>;
  /** Plugin runtime for direct API access (avoids CLI subprocess timeouts) */
  runtime?: PluginRuntime;
}): Promise<CompletionOutput> {
  const { workspaceDir, groupId, role, result, issueId, summary, provider, repoPath, projectName, channel, pluginConfig, runtime } = opts;
  const key = `${role}:${result}`;
  const rule = COMPLETION_RULES[key];
  if (!rule) throw new Error(`No completion rule for ${key}`);

  let prUrl = opts.prUrl;

  // Git pull (dev:done)
  if (rule.gitPull) {
    try {
      await runCommand(["git", "pull"], { timeoutMs: 30_000, cwd: repoPath });
    } catch { /* best-effort */ }
  }

  // Auto-detect PR URL (dev:done)
  if (rule.detectPr && !prUrl) {
    try { prUrl = await provider.getMergedMRUrl(issueId) ?? undefined; } catch { /* ignore */ }
  }

  // Get issue early (for URL in notification)
  const issue = await provider.getIssue(issueId);

  // Send notification early (before deactivation and label transition which can fail)
  // This ensures users see the notification even if subsequent steps have issues
  const notifyConfig = getNotificationConfig(pluginConfig);
  notify(
    {
      type: "workerComplete",
      project: projectName,
      groupId,
      issueId,
      issueUrl: issue.web_url,
      role,
      result: result as "done" | "pass" | "fail" | "refine" | "blocked",
      summary,
      nextState: NEXT_STATE[key],
    },
    {
      workspaceDir,
      config: notifyConfig,
      groupId,
      channel: channel ?? "telegram",
      runtime,
    },
  ).catch(() => { /* non-fatal */ });

  // Deactivate worker + transition label
  await deactivateWorker(workspaceDir, groupId, role);
  await provider.transitionLabel(issueId, rule.from, rule.to);

  // Close/reopen
  if (rule.closeIssue) await provider.closeIssue(issueId);
  if (rule.reopenIssue) await provider.reopenIssue(issueId);

  // Build announcement
  const emoji = EMOJI[key] ?? "📋";
  const label = key.replace(":", " ").toUpperCase();
  let announcement = `${emoji} ${label} #${issueId}`;
  if (summary) announcement += ` — ${summary}`;
  announcement += `\n📋 Issue: ${issue.web_url}`;
  if (prUrl) announcement += `\n🔗 PR: ${prUrl}`;
  announcement += `\n${NEXT_STATE[key]}.`;

  return {
    labelTransition: `${rule.from} → ${rule.to}`,
    announcement,
    nextState: NEXT_STATE[key],
    prUrl,
    issueUrl: issue.web_url,
    issueClosed: rule.closeIssue,
    issueReopened: rule.reopenIssue,
  };
}
