/**
 * GitLabProvider — IssueProvider implementation using glab CLI.
 */
import {
  type IssueProvider,
  type Issue,
  type StateLabel,
  type IssueComment,
  type PrStatus,
  PrState,
} from "./provider.js";
import { runCommand } from "../run-command.js";
import { withResilience } from "./resilience.js";
import {
  DEFAULT_WORKFLOW,
  getStateLabels,
  getLabelColors,
  type WorkflowConfig,
} from "../workflow.js";

type GitLabMR = {
  iid: number;
  title: string;
  description: string;
  web_url: string;
  state: string;
  source_branch?: string;
  merged_at: string | null;
  approved_by?: Array<unknown>;
};

export class GitLabProvider implements IssueProvider {
  private repoPath: string;
  private workflow: WorkflowConfig;

  constructor(opts: { repoPath: string; workflow?: WorkflowConfig }) {
    this.repoPath = opts.repoPath;
    this.workflow = opts.workflow ?? DEFAULT_WORKFLOW;
  }

  private async glab(args: string[]): Promise<string> {
    return withResilience(async () => {
      const result = await runCommand(["glab", ...args], { timeoutMs: 30_000, cwd: this.repoPath });
      return result.stdout.trim();
    });
  }

  /** Get MRs linked to an issue via GitLab's native related_merge_requests API. */
  private async getRelatedMRs(issueId: number): Promise<GitLabMR[]> {
    try {
      const raw = await this.glab(["api", `projects/:id/issues/${issueId}/related_merge_requests`, "--paginate"]);
      if (!raw) return [];
      return JSON.parse(raw) as GitLabMR[];
    } catch { return []; }
  }

  async ensureLabel(name: string, color: string): Promise<void> {
    try { await this.glab(["label", "create", "--name", name, "--color", color]); }
    catch (err) { const msg = (err as Error).message ?? ""; if (!msg.includes("already exists") && !msg.includes("409")) throw err; }
  }

  async ensureAllStateLabels(): Promise<void> {
    const labels = getStateLabels(this.workflow);
    const colors = getLabelColors(this.workflow);
    for (const label of labels) {
      await this.ensureLabel(label, colors[label]);
    }
  }

  async createIssue(title: string, description: string, label: StateLabel, assignees?: string[]): Promise<Issue> {
    // Pass description directly as argv — runCommand uses spawn (no shell),
    // so no escaping issues with special characters.
    const args = ["issue", "create", "--title", title, "--description", description, "--label", label];
    if (assignees?.length) args.push("--assignee", assignees.join(","));
    const stdout = await this.glab(args);
    // glab issue create returns the issue URL
    const match = stdout.match(/\/issues\/(\d+)/);
    if (!match) throw new Error(`Failed to parse issue URL: ${stdout}`);
    return this.getIssue(parseInt(match[1], 10));
  }

  async listIssuesByLabel(label: StateLabel): Promise<Issue[]> {
    try {
      const raw = await this.glab(["issue", "list", "--label", label, "--output", "json"]);
      return JSON.parse(raw) as Issue[];
    } catch { return []; }
  }

  async getIssue(issueId: number): Promise<Issue> {
    const raw = await this.glab(["issue", "view", String(issueId), "--output", "json"]);
    return JSON.parse(raw) as Issue;
  }

  async listComments(issueId: number): Promise<IssueComment[]> {
    try {
      const raw = await this.glab(["api", `projects/:id/issues/${issueId}/notes`, "--paginate"]);
      const notes = JSON.parse(raw) as Array<{ author: { username: string }; body: string; created_at: string; system: boolean }>;
      // Filter out system notes (e.g. "changed label", "closed issue")
      return notes
        .filter((note) => !note.system)
        .map((note) => ({
          author: note.author.username,
          body: note.body,
          created_at: note.created_at,
        }));
    } catch { return []; }
  }

  async transitionLabel(issueId: number, from: StateLabel, to: StateLabel): Promise<void> {
    const issue = await this.getIssue(issueId);
    const stateLabels = getStateLabels(this.workflow);
    const currentStateLabels = issue.labels.filter((l) => stateLabels.includes(l));
    const args = ["issue", "update", String(issueId)];
    for (const l of currentStateLabels) args.push("--unlabel", l);
    args.push("--label", to);
    await this.glab(args);
  }

  async addLabel(issueId: number, label: string): Promise<void> {
    await this.glab(["issue", "update", String(issueId), "--label", label]);
  }

  async removeLabels(issueId: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return;
    const args = ["issue", "update", String(issueId)];
    for (const l of labels) args.push("--unlabel", l);
    await this.glab(args);
  }

  async closeIssue(issueId: number): Promise<void> { await this.glab(["issue", "close", String(issueId)]); }
  async reopenIssue(issueId: number): Promise<void> { await this.glab(["issue", "reopen", String(issueId)]); }

  hasStateLabel(issue: Issue, expected: StateLabel): boolean { return issue.labels.includes(expected); }

  getCurrentStateLabel(issue: Issue): StateLabel | null {
    const stateLabels = getStateLabels(this.workflow);
    return stateLabels.find((l) => issue.labels.includes(l)) ?? null;
  }

  async hasMergedMR(issueId: number): Promise<boolean> {
    const mrs = await this.getRelatedMRs(issueId);
    return mrs.some((mr) => mr.state === "merged");
  }

  async getMergedMRUrl(issueId: number): Promise<string | null> {
    const mrs = await this.getRelatedMRs(issueId);
    const merged = mrs
      .filter((mr) => mr.state === "merged" && mr.merged_at)
      .sort((a, b) => new Date(b.merged_at!).getTime() - new Date(a.merged_at!).getTime());
    return merged[0]?.web_url ?? null;
  }

  async getPrStatus(issueId: number): Promise<PrStatus> {
    const mrs = await this.getRelatedMRs(issueId);
    // Check open MRs first
    const open = mrs.find((mr) => mr.state === "opened");
    if (open) {
      // related_merge_requests doesn't populate approved_by — use dedicated approvals endpoint
      const approved = await this.isMrApproved(open.iid);
      return { state: approved ? PrState.APPROVED : PrState.OPEN, url: open.web_url, title: open.title, sourceBranch: open.source_branch };
    }
    // Check merged MRs
    const merged = mrs.find((mr) => mr.state === "merged");
    if (merged) return { state: PrState.MERGED, url: merged.web_url, title: merged.title, sourceBranch: merged.source_branch };
    return { state: PrState.CLOSED, url: null };
  }

  /** Check if an MR is approved via the dedicated approvals endpoint. */
  private async isMrApproved(mrIid: number): Promise<boolean> {
    try {
      const raw = await this.glab(["api", `projects/:id/merge_requests/${mrIid}/approvals`]);
      const data = JSON.parse(raw) as {
        approved?: boolean;
        approvals_left?: number;
        approved_by?: Array<unknown>;
      };
      // Require at least one explicit approval.  When a project has zero
      // approval rules, GitLab returns approvals_left:0 even though nobody
      // has actually reviewed — so approvals_left alone is not trustworthy.
      if (data.approved === true) return true;
      const hasExplicitApproval = Array.isArray(data.approved_by) && data.approved_by.length > 0;
      return hasExplicitApproval && (data.approvals_left ?? 1) === 0;
    } catch { return false; }
  }

  async mergePr(issueId: number): Promise<void> {
    const mrs = await this.getRelatedMRs(issueId);
    const open = mrs.find((mr) => mr.state === "opened");
    if (!open) throw new Error(`No open MR found for issue #${issueId}`);
    await this.glab(["mr", "merge", String(open.iid)]);
  }

  async getPrDiff(issueId: number): Promise<string | null> {
    const mrs = await this.getRelatedMRs(issueId);
    const open = mrs.find((mr) => mr.state === "opened");
    if (!open) return null;
    try {
      return await this.glab(["mr", "diff", String(open.iid)]);
    } catch { return null; }
  }

  async addComment(issueId: number, body: string): Promise<void> {
    // Pass message directly as argv — no shell escaping needed with spawn
    await this.glab(["issue", "note", String(issueId), "--message", body]);
  }

  async healthCheck(): Promise<boolean> {
    try { await this.glab(["auth", "status"]); return true; } catch { return false; }
  }
}
