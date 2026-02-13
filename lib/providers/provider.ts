/**
 * IssueProvider — Abstract interface for issue tracker operations.
 *
 * Implementations: GitHub (gh CLI), GitLab (glab CLI).
 */

export const STATE_LABELS = [
  "Planning", "To Do", "Doing", "To Test", "Testing", "Done", "To Improve", "Refining",
] as const;

export type StateLabel = (typeof STATE_LABELS)[number];

export const LABEL_COLORS: Record<StateLabel, string> = {
  Planning: "#95a5a6", "To Do": "#428bca", Doing: "#f0ad4e", "To Test": "#5bc0de",
  Testing: "#9b59b6", Done: "#5cb85c", "To Improve": "#d9534f", Refining: "#f39c12",
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
  ensureLabel(name: string, color: string): Promise<void>;
  ensureAllStateLabels(): Promise<void>;
  createIssue(title: string, description: string, label: StateLabel, assignees?: string[]): Promise<Issue>;
  listIssuesByLabel(label: StateLabel): Promise<Issue[]>;
  getIssue(issueId: number): Promise<Issue>;
  transitionLabel(issueId: number, from: StateLabel, to: StateLabel): Promise<void>;
  closeIssue(issueId: number): Promise<void>;
  reopenIssue(issueId: number): Promise<void>;
  hasStateLabel(issue: Issue, expected: StateLabel): boolean;
  getCurrentStateLabel(issue: Issue): StateLabel | null;
  hasMergedMR(issueId: number): Promise<boolean>;
  getMergedMRUrl(issueId: number): Promise<string | null>;
  addComment(issueId: number, body: string): Promise<void>;
  healthCheck(): Promise<boolean>;
}

/** @deprecated Use IssueProvider */
export type TaskManager = IssueProvider;
