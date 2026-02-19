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
  /** PR/MR is open with no formal review state, but has top-level comments from non-authors. */
  HAS_COMMENTS: "has_comments",
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
  /** List issues with optional filters. Provider-agnostic — future Jira/Linear/Trello can map to native queries. */
  listIssues(opts?: { label?: string; state?: "open" | "closed" | "all" }): Promise<Issue[]>;
  getIssue(issueId: number): Promise<Issue>;
  listComments(issueId: number): Promise<IssueComment[]>;
  transitionLabel(issueId: number, from: StateLabel, to: StateLabel): Promise<void>;
  addLabel(issueId: number, label: string): Promise<void>;
  removeLabels(issueId: number, labels: string[]): Promise<void>;
  closeIssue(issueId: number): Promise<void>;
  reopenIssue(issueId: number): Promise<void>;
  getMergedMRUrl(issueId: number): Promise<string | null>;
  getPrStatus(issueId: number): Promise<PrStatus>;
  mergePr(issueId: number): Promise<void>;
  getPrDiff(issueId: number): Promise<string | null>;
  /** Get review comments on the PR linked to an issue. */
  getPrReviewComments(issueId: number): Promise<PrReviewComment[]>;
  /**
   * Check if work for an issue is already present on the base branch via git history.
   * Used as a fallback when no PR exists (e.g., work committed directly to main).
   * Searches recent git log on the base branch for commits mentioning issue #N or !N.
   * @param issueId  Issue number to search for
   * @param baseBranch  Branch to search (e.g. "main")
   */
  isCommitOnBaseBranch(issueId: number, baseBranch: string): Promise<boolean>;
  /**
   * Add an emoji reaction to a PR/MR comment by its comment ID.
   * Best-effort — implementations should not throw.
   * @param issueId  Issue ID (used to locate the associated PR/MR)
   * @param commentId  The numeric ID of the comment to react to
   * @param emoji  Reaction name understood by the provider (e.g. "rocket", "+1")
   */
  reactToPrComment(issueId: number, commentId: number, emoji: string): Promise<void>;
  /**
   * Add an emoji reaction to a PR review (not a comment) by its review ID.
   * Best-effort — implementations should not throw.
   */
  reactToPrReview(issueId: number, reviewId: number, emoji: string): Promise<void>;
  addComment(issueId: number, body: string): Promise<void>;
  editIssue(issueId: number, updates: { title?: string; body?: string }): Promise<Issue>;
  healthCheck(): Promise<boolean>;
}
