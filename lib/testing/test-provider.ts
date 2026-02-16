/**
 * TestProvider — In-memory IssueProvider for integration tests.
 *
 * Tracks all method calls for assertion. Issues are stored in a simple map.
 * No external dependencies — pure TypeScript.
 */
import type {
  IssueProvider,
  Issue,
  StateLabel,
  IssueComment,
  PrStatus,
} from "../providers/provider.js";
import { getStateLabels } from "../workflow.js";
import { DEFAULT_WORKFLOW, type WorkflowConfig } from "../workflow.js";

// ---------------------------------------------------------------------------
// Call tracking
// ---------------------------------------------------------------------------

export type ProviderCall =
  | { method: "ensureLabel"; args: { name: string; color: string } }
  | { method: "ensureAllStateLabels"; args: {} }
  | {
      method: "createIssue";
      args: {
        title: string;
        description: string;
        label: StateLabel;
        assignees?: string[];
      };
    }
  | { method: "listIssuesByLabel"; args: { label: StateLabel } }
  | { method: "getIssue"; args: { issueId: number } }
  | { method: "listComments"; args: { issueId: number } }
  | {
      method: "transitionLabel";
      args: { issueId: number; from: StateLabel; to: StateLabel };
    }
  | { method: "addLabel"; args: { issueId: number; label: string } }
  | { method: "removeLabels"; args: { issueId: number; labels: string[] } }
  | { method: "closeIssue"; args: { issueId: number } }
  | { method: "reopenIssue"; args: { issueId: number } }
  | { method: "hasMergedMR"; args: { issueId: number } }
  | { method: "getMergedMRUrl"; args: { issueId: number } }
  | { method: "getPrStatus"; args: { issueId: number } }
  | { method: "mergePr"; args: { issueId: number } }
  | { method: "getPrDiff"; args: { issueId: number } }
  | { method: "addComment"; args: { issueId: number; body: string } }
  | { method: "healthCheck"; args: {} };

// ---------------------------------------------------------------------------
// TestProvider
// ---------------------------------------------------------------------------

export class TestProvider implements IssueProvider {
  /** All issues keyed by iid. */
  issues = new Map<number, Issue>();
  /** Comments per issue. */
  comments = new Map<number, IssueComment[]>();
  /** Labels that have been ensured. */
  labels = new Map<string, string>();
  /** PR status overrides per issue. Default: { state: "closed", url: null }. */
  prStatuses = new Map<number, PrStatus>();
  /** Merged MR URLs per issue. */
  mergedMrUrls = new Map<number, string>();
  /** Issue IDs where mergePr should fail (simulates merge conflicts). */
  mergePrFailures = new Set<number>();
  /** PR diffs per issue (for reviewer tests). */
  prDiffs = new Map<number, string>();
  /** All calls, in order. */
  calls: ProviderCall[] = [];

  private nextIssueId = 1;
  private workflow: WorkflowConfig;

  constructor(opts?: { workflow?: WorkflowConfig }) {
    this.workflow = opts?.workflow ?? DEFAULT_WORKFLOW;
  }

  // -------------------------------------------------------------------------
  // Test helpers
  // -------------------------------------------------------------------------

  /** Create an issue directly in the store (bypasses createIssue tracking). */
  seedIssue(overrides: Partial<Issue> & { iid: number }): Issue {
    const issue: Issue = {
      iid: overrides.iid,
      title: overrides.title ?? `Issue #${overrides.iid}`,
      description: overrides.description ?? "",
      labels: overrides.labels ?? [],
      state: overrides.state ?? "opened",
      web_url:
        overrides.web_url ?? `https://example.com/issues/${overrides.iid}`,
    };
    this.issues.set(issue.iid, issue);
    if (issue.iid >= this.nextIssueId) this.nextIssueId = issue.iid + 1;
    return issue;
  }

  /** Set PR status for an issue (used by review pass tests). */
  setPrStatus(issueId: number, status: PrStatus): void {
    this.prStatuses.set(issueId, status);
  }

  /** Get calls filtered by method name. */
  callsTo<M extends ProviderCall["method"]>(
    method: M,
  ): Extract<ProviderCall, { method: M }>[] {
    return this.calls.filter((c) => c.method === method) as any;
  }

  /** Reset call tracking (keeps issue state). */
  resetCalls(): void {
    this.calls = [];
  }

  /** Full reset — clear everything. */
  reset(): void {
    this.issues.clear();
    this.comments.clear();
    this.labels.clear();
    this.prStatuses.clear();
    this.mergedMrUrls.clear();
    this.mergePrFailures.clear();
    this.prDiffs.clear();
    this.calls = [];
    this.nextIssueId = 1;
  }

  // -------------------------------------------------------------------------
  // IssueProvider implementation
  // -------------------------------------------------------------------------

  async ensureLabel(name: string, color: string): Promise<void> {
    this.calls.push({ method: "ensureLabel", args: { name, color } });
    this.labels.set(name, color);
  }

  async ensureAllStateLabels(): Promise<void> {
    this.calls.push({ method: "ensureAllStateLabels", args: {} });
    const stateLabels = getStateLabels(this.workflow);
    for (const label of stateLabels) {
      this.labels.set(label, "#000000");
    }
  }

  async createIssue(
    title: string,
    description: string,
    label: StateLabel,
    assignees?: string[],
  ): Promise<Issue> {
    this.calls.push({
      method: "createIssue",
      args: { title, description, label, assignees },
    });
    const iid = this.nextIssueId++;
    const issue: Issue = {
      iid,
      title,
      description,
      labels: [label],
      state: "opened",
      web_url: `https://example.com/issues/${iid}`,
    };
    this.issues.set(iid, issue);
    return issue;
  }

  async listIssuesByLabel(label: StateLabel): Promise<Issue[]> {
    this.calls.push({ method: "listIssuesByLabel", args: { label } });
    return [...this.issues.values()].filter((i) => i.labels.includes(label));
  }

  async getIssue(issueId: number): Promise<Issue> {
    this.calls.push({ method: "getIssue", args: { issueId } });
    const issue = this.issues.get(issueId);
    if (!issue) throw new Error(`Issue #${issueId} not found in TestProvider`);
    return issue;
  }

  async listComments(issueId: number): Promise<IssueComment[]> {
    this.calls.push({ method: "listComments", args: { issueId } });
    return this.comments.get(issueId) ?? [];
  }

  async transitionLabel(
    issueId: number,
    from: StateLabel,
    to: StateLabel,
  ): Promise<void> {
    this.calls.push({ method: "transitionLabel", args: { issueId, from, to } });
    const issue = this.issues.get(issueId);
    if (!issue) throw new Error(`Issue #${issueId} not found in TestProvider`);
    // Remove all state labels, add the new one
    const stateLabels = getStateLabels(this.workflow);
    issue.labels = issue.labels.filter((l) => !stateLabels.includes(l));
    issue.labels.push(to);
  }

  async addLabel(issueId: number, label: string): Promise<void> {
    this.calls.push({ method: "addLabel", args: { issueId, label } });
    const issue = this.issues.get(issueId);
    if (issue && !issue.labels.includes(label)) {
      issue.labels.push(label);
    }
  }

  async removeLabels(issueId: number, labels: string[]): Promise<void> {
    this.calls.push({ method: "removeLabels", args: { issueId, labels } });
    const issue = this.issues.get(issueId);
    if (issue) {
      issue.labels = issue.labels.filter((l) => !labels.includes(l));
    }
  }

  async closeIssue(issueId: number): Promise<void> {
    this.calls.push({ method: "closeIssue", args: { issueId } });
    const issue = this.issues.get(issueId);
    if (issue) issue.state = "closed";
  }

  async reopenIssue(issueId: number): Promise<void> {
    this.calls.push({ method: "reopenIssue", args: { issueId } });
    const issue = this.issues.get(issueId);
    if (issue) issue.state = "opened";
  }

  hasStateLabel(issue: Issue, expected: StateLabel): boolean {
    return issue.labels.includes(expected);
  }

  getCurrentStateLabel(issue: Issue): StateLabel | null {
    const stateLabels = getStateLabels(this.workflow);
    return stateLabels.find((l) => issue.labels.includes(l)) ?? null;
  }

  async hasMergedMR(issueId: number): Promise<boolean> {
    this.calls.push({ method: "hasMergedMR", args: { issueId } });
    return this.mergedMrUrls.has(issueId);
  }

  async getMergedMRUrl(issueId: number): Promise<string | null> {
    this.calls.push({ method: "getMergedMRUrl", args: { issueId } });
    return this.mergedMrUrls.get(issueId) ?? null;
  }

  async getPrStatus(issueId: number): Promise<PrStatus> {
    this.calls.push({ method: "getPrStatus", args: { issueId } });
    return this.prStatuses.get(issueId) ?? { state: "closed", url: null };
  }

  async mergePr(issueId: number): Promise<void> {
    this.calls.push({ method: "mergePr", args: { issueId } });
    if (this.mergePrFailures.has(issueId)) {
      throw new Error(`Merge conflict: cannot merge PR for issue #${issueId}`);
    }
    // Simulate successful merge — update PR status to merged
    const existing = this.prStatuses.get(issueId);
    if (existing) {
      this.prStatuses.set(issueId, { state: "merged", url: existing.url });
    }
  }

  async getPrDiff(issueId: number): Promise<string | null> {
    this.calls.push({ method: "getPrDiff", args: { issueId } });
    return this.prDiffs.get(issueId) ?? null;
  }

  async addComment(issueId: number, body: string): Promise<void> {
    this.calls.push({ method: "addComment", args: { issueId, body } });
    const existing = this.comments.get(issueId) ?? [];
    existing.push({
      author: "test",
      body,
      created_at: new Date().toISOString(),
    });
    this.comments.set(issueId, existing);
  }

  async healthCheck(): Promise<boolean> {
    this.calls.push({ method: "healthCheck", args: {} });
    return true;
  }
}
