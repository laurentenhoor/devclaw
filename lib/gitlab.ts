/**
 * @deprecated This module is deprecated and kept only for reference.
 * Use lib/providers/index.ts with createProvider() for GitLab/GitHub abstraction.
 * 
 * GitLab wrapper using glab CLI.
 * Handles label transitions, issue fetching, and MR verification.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// State labels — each issue has exactly ONE at a time
const STATE_LABELS = [
  "Planning",
  "To Do",
  "Doing",
  "To Test",
  "Testing",
  "Done",
  "To Improve",
  "Refining",
] as const;

export type StateLabel = (typeof STATE_LABELS)[number];

type GlabOptions = {
  repoPath: string;
};

async function glab(
  args: string[],
  opts: GlabOptions,
): Promise<string> {
  const { stdout } = await execFileAsync("glab", args, {
    cwd: opts.repoPath,
    timeout: 30_000,
  });
  return stdout.trim();
}

export type GitLabIssue = {
  iid: number;
  title: string;
  description: string;
  labels: string[];
  state: string;
  web_url: string;
};

/**
 * Fetch a single issue by ID.
 */
export async function getIssue(
  issueId: number,
  opts: GlabOptions,
): Promise<GitLabIssue> {
  const raw = await glab(
    ["issue", "view", String(issueId), "--output", "json"],
    opts,
  );
  return JSON.parse(raw) as GitLabIssue;
}

/**
 * List issues with a specific label.
 */
export async function listIssuesByLabel(
  label: StateLabel,
  opts: GlabOptions,
): Promise<GitLabIssue[]> {
  try {
    const raw = await glab(
      ["issue", "list", "--label", label, "--output", "json"],
      opts,
    );
    return JSON.parse(raw) as GitLabIssue[];
  } catch {
    // glab returns error when no issues found
    return [];
  }
}

/**
 * Transition an issue from one state label to another.
 * Uses --unlabel + --label to ensure only one state label at a time.
 */
export async function transitionLabel(
  issueId: number,
  from: StateLabel,
  to: StateLabel,
  opts: GlabOptions,
): Promise<void> {
  await glab(
    [
      "issue",
      "update",
      String(issueId),
      "--unlabel",
      from,
      "--label",
      to,
    ],
    opts,
  );
}

/**
 * Close an issue.
 */
export async function closeIssue(
  issueId: number,
  opts: GlabOptions,
): Promise<void> {
  await glab(["issue", "close", String(issueId)], opts);
}

/**
 * Reopen an issue.
 */
export async function reopenIssue(
  issueId: number,
  opts: GlabOptions,
): Promise<void> {
  await glab(["issue", "reopen", String(issueId)], opts);
}

/**
 * Check if the current state label on an issue matches expected.
 */
export function hasStateLabel(
  issue: GitLabIssue,
  expected: StateLabel,
): boolean {
  return issue.labels.includes(expected);
}

/**
 * Get the current state label of an issue (first match from STATE_LABELS).
 */
export function getCurrentStateLabel(
  issue: GitLabIssue,
): StateLabel | null {
  for (const label of STATE_LABELS) {
    if (issue.labels.includes(label)) {
      return label;
    }
  }
  return null;
}

/**
 * Check if any merged MR exists for a specific issue.
 */
export async function hasMergedMR(
  issueId: number,
  opts: GlabOptions,
): Promise<boolean> {
  try {
    const raw = await glab(
      ["mr", "list", "--output", "json", "--state", "merged"],
      opts,
    );
    const mrs = JSON.parse(raw) as Array<{ title: string; description: string }>;
    const pattern = `#${issueId}`;
    return mrs.some(
      (mr) =>
        mr.title.includes(pattern) || (mr.description ?? "").includes(pattern),
    );
  } catch {
    return false;
  }
}

/**
 * Resolve the repo path from projects.json repo field (handles ~/).
 */
export function resolveRepoPath(repoField: string): string {
  if (repoField.startsWith("~/")) {
    return repoField.replace("~", process.env.HOME ?? "/home/lauren");
  }
  return repoField;
}
