/**
 * Pipeline service — declarative completion rules.
 *
 * Replaces 7 if-blocks with a data-driven lookup table.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { StateLabel, IssueProvider } from "../providers/provider.js";
import { deactivateWorker } from "../projects.js";

const execFileAsync = promisify(execFile);

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
  "dev:blocked": { from: "Doing",   to: "To Do" },
  "qa:blocked":  { from: "Testing", to: "To Test" },
};

export const NEXT_STATE: Record<string, string> = {
  "dev:done":    "QA queue",
  "dev:blocked": "returned to queue",
  "qa:pass":     "Done!",
  "qa:fail":     "back to DEV",
  "qa:refine":   "awaiting human decision",
  "qa:blocked":  "returned to QA queue",
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
}): Promise<CompletionOutput> {
  const { workspaceDir, groupId, role, result, issueId, summary, provider, repoPath } = opts;
  const key = `${role}:${result}`;
  const rule = COMPLETION_RULES[key];
  if (!rule) throw new Error(`No completion rule for ${key}`);

  let prUrl = opts.prUrl;

  // Git pull (dev:done)
  if (rule.gitPull) {
    try {
      await execFileAsync("git", ["pull"], { cwd: repoPath, timeout: 30_000 });
    } catch { /* best-effort */ }
  }

  // Auto-detect PR URL (dev:done)
  if (rule.detectPr && !prUrl) {
    try { prUrl = await provider.getMergedMRUrl(issueId) ?? undefined; } catch { /* ignore */ }
  }

  // Deactivate worker + transition label
  await deactivateWorker(workspaceDir, groupId, role);
  await provider.transitionLabel(issueId, rule.from, rule.to);

  // Close/reopen
  if (rule.closeIssue) await provider.closeIssue(issueId);
  if (rule.reopenIssue) await provider.reopenIssue(issueId);

  // Build announcement
  const issue = await provider.getIssue(issueId);
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
