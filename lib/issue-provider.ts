/**
 * IssueProvider — Abstract interface for issue tracker operations.
 *
 * GitLab is the first implementation (via glab CLI).
 * Future providers: GitHub (via gh CLI), Jira (via API).
 *
 * All DevClaw tools operate through this interface, making it possible
 * to swap issue trackers without changing tool logic.
 */

export const STATE_LABELS = [
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

export const LABEL_COLORS: Record<StateLabel, string> = {
  Planning: "#6699cc",
  "To Do": "#428bca",
  Doing: "#f0ad4e",
  "To Test": "#5bc0de",
  Testing: "#9b59b6",
  Done: "#5cb85c",
  "To Improve": "#d9534f",
  Refining: "#f39c12",
};

export type Issue = {
  iid: number;
  title: string;
  description: string;
  labels: string[];
  state: string;
  web_url: string;
};

export interface IssueProvider {
  /** Create a label if it doesn't exist (idempotent). */
  ensureLabel(name: string, color: string): Promise<void>;

  /** Create all 8 state labels (idempotent). */
  ensureAllStateLabels(): Promise<void>;

  /** Create a new issue. */
  createIssue(title: string, description: string, label: StateLabel, assignees?: string[]): Promise<Issue>;

  /** List issues with a specific state label. */
  listIssuesByLabel(label: StateLabel): Promise<Issue[]>;

  /** Fetch a single issue by ID. */
  getIssue(issueId: number): Promise<Issue>;

  /** Transition an issue from one state label to another (atomic unlabel + label). */
  transitionLabel(issueId: number, from: StateLabel, to: StateLabel): Promise<void>;

  /** Close an issue. */
  closeIssue(issueId: number): Promise<void>;

  /** Reopen an issue. */
  reopenIssue(issueId: number): Promise<void>;

  /** Check if an issue has a specific state label. */
  hasStateLabel(issue: Issue, expected: StateLabel): boolean;

  /** Get the current state label of an issue. */
  getCurrentStateLabel(issue: Issue): StateLabel | null;

  /** Check if any merged MR/PR exists for a specific issue. */
  hasMergedMR(issueId: number): Promise<boolean>;

  /** Verify the provider is working (CLI available, auth valid, repo accessible). */
  healthCheck(): Promise<boolean>;
}
