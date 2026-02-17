/**
 * IssueProvider — Abstract interface for issue tracker operations.
 *
 * Implementations: GitHub (gh CLI), GitLab (glab CLI).
 */

/**
 * StateLabel type — string for flexibility with custom workflows.
 */
export type StateLabel = string;

// ---------------------------------------------------------------------------
// Issue types
// ---------------------------------------------------------------------------

export type Issue = {
  iid: number;
  title: string;
  description: string;
  labels: string[];
  state: string;
  web_url: string;
};

export type IssueComment = {
  author: string;
  body: string;
  created_at: string;
};

/** Built-in PR states. */
export const PrState = {
  OPEN: "open",
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  MERGED: "merged",
  CLOSED: "closed",
} as const;
export type PrState = (typeof PrState)[keyof typeof PrState];

export type PrStatus = {
  state: PrState;
  url: string | null;
  /** MR/PR title (e.g. "feat: add login page"). */
  title?: string;
  /** Source branch name (e.g. "feature/7-blog-cms"). */
  sourceBranch?: string;
  /** false = has merge conflicts. undefined = unknown or not applicable. */
  mergeable?: boolean;
};

/** A review comment on a PR/MR. */
export type PrReviewComment = {
  id: number;
  author: string;
  body: string;
  /** "APPROVED", "CHANGES_REQUESTED", "COMMENTED" */
  state: string;
  created_at: string;
  /** File path for inline comments. */
  path?: string;
  /** Line number for inline comments. */
  line?: number;
};

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface IssueProvider {
  ensureLabel(name: string, color: string): Promise<void>;
  ensureAllStateLabels(): Promise<void>;
  createIssue(title: string, description: string, label: StateLabel, assignees?: string[]): Promise<Issue>;
  listIssuesByLabel(label: StateLabel): Promise<Issue[]>;
  getIssue(issueId: number): Promise<Issue>;
  listComments(issueId: number): Promise<IssueComment[]>;
  transitionLabel(issueId: number, from: StateLabel, to: StateLabel): Promise<void>;
  addLabel(issueId: number, label: string): Promise<void>;
  removeLabels(issueId: number, labels: string[]): Promise<void>;
  closeIssue(issueId: number): Promise<void>;
  reopenIssue(issueId: number): Promise<void>;
  hasStateLabel(issue: Issue, expected: StateLabel): boolean;
  getCurrentStateLabel(issue: Issue): StateLabel | null;
  hasMergedMR(issueId: number): Promise<boolean>;
  getMergedMRUrl(issueId: number): Promise<string | null>;
  getPrStatus(issueId: number): Promise<PrStatus>;
  mergePr(issueId: number): Promise<void>;
  getPrDiff(issueId: number): Promise<string | null>;
  /** Get review comments on the PR linked to an issue. */
  getPrReviewComments(issueId: number): Promise<PrReviewComment[]>;
  /** React to a PR comment with an emoji (e.g. "+1"). Best-effort. */
  reactToPrComment(issueId: number, commentId: number, emoji: string): Promise<void>;
  addComment(issueId: number, body: string): Promise<void>;
  editIssue(issueId: number, updates: { title?: string; body?: string }): Promise<Issue>;
  healthCheck(): Promise<boolean>;
}
