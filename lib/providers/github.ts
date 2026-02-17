/**
 * GitHubProvider — IssueProvider implementation using gh CLI.
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

type GhIssue = {
  number: number;
  title: string;
  body: string;
  labels: Array<{ name: string }>;
  state: string;
  url: string;
};

function toIssue(gh: GhIssue): Issue {
  return {
    iid: gh.number, title: gh.title, description: gh.body ?? "",
    labels: gh.labels.map((l) => l.name), state: gh.state, web_url: gh.url,
  };
}

export class GitHubProvider implements IssueProvider {
  private repoPath: string;
  private workflow: WorkflowConfig;

  constructor(opts: { repoPath: string; workflow?: WorkflowConfig }) {
    this.repoPath = opts.repoPath;
    this.workflow = opts.workflow ?? DEFAULT_WORKFLOW;
  }

  private async gh(args: string[]): Promise<string> {
    return withResilience(async () => {
      const result = await runCommand(["gh", ...args], { timeoutMs: 30_000, cwd: this.repoPath });
      return result.stdout.trim();
    });
  }

  /**
   * Find PRs associated with an issue.
   * Primary: match by head branch pattern (fix/123-, feature/123-, etc.)
   * Fallback: word-boundary match on #123 in title/body.
   */
  private async findPrsForIssue<T extends { title: string; body: string; headRefName?: string }>(
    issueId: number,
    state: "open" | "merged" | "all",
    fields: string,
  ): Promise<T[]> {
    try {
      const args = ["pr", "list", "--json", fields, "--limit", "50"];
      if (state !== "all") args.push("--state", state);
      const raw = await this.gh(args);
      if (!raw) return [];
      const prs = JSON.parse(raw) as T[];
      const branchPat = new RegExp(`^(?:fix|feature|chore|bugfix|hotfix)/${issueId}-`);
      const titlePat = new RegExp(`\\b#${issueId}\\b`);

      // Primary: match by branch name
      const byBranch = prs.filter((pr) => pr.headRefName && branchPat.test(pr.headRefName));
      if (byBranch.length > 0) return byBranch;

      // Fallback: word-boundary match in title/body
      return prs.filter((pr) => titlePat.test(pr.title) || titlePat.test(pr.body ?? ""));
    } catch { return []; }
  }

  async ensureLabel(name: string, color: string): Promise<void> {
    try { await this.gh(["label", "create", name, "--color", color.replace(/^#/, "")]); }
    catch (err) { if (!(err as Error).message?.includes("already exists")) throw err; }
  }

  async ensureAllStateLabels(): Promise<void> {
    const labels = getStateLabels(this.workflow);
    const colors = getLabelColors(this.workflow);
    for (const label of labels) {
      await this.ensureLabel(label, colors[label]);
    }
  }

  async createIssue(title: string, description: string, label: StateLabel, assignees?: string[]): Promise<Issue> {
    const args = ["issue", "create", "--title", title, "--body", description, "--label", label];
    if (assignees?.length) args.push("--assignee", assignees.join(","));
    const url = await this.gh(args);
    const match = url.match(/\/issues\/(\d+)$/);
    if (!match) throw new Error(`Failed to parse issue URL: ${url}`);
    return this.getIssue(parseInt(match[1], 10));
  }

  async listIssuesByLabel(label: StateLabel): Promise<Issue[]> {
    try {
      const raw = await this.gh(["issue", "list", "--label", label, "--state", "open", "--json", "number,title,body,labels,state,url"]);
      return (JSON.parse(raw) as GhIssue[]).map(toIssue);
    } catch { return []; }
  }

  async getIssue(issueId: number): Promise<Issue> {
    const raw = await this.gh(["issue", "view", String(issueId), "--json", "number,title,body,labels,state,url"]);
    return toIssue(JSON.parse(raw) as GhIssue);
  }

  async listComments(issueId: number): Promise<IssueComment[]> {
    try {
      const raw = await this.gh(["api", `repos/:owner/:repo/issues/${issueId}/comments`, "--jq", ".[] | {author: .user.login, body: .body, created_at: .created_at}"]);
      if (!raw) return [];
      return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    } catch { return []; }
  }

  async transitionLabel(issueId: number, from: StateLabel, to: StateLabel): Promise<void> {
    const issue = await this.getIssue(issueId);
    const stateLabels = getStateLabels(this.workflow);
    const currentStateLabels = issue.labels.filter((l) => stateLabels.includes(l));
    const args = ["issue", "edit", String(issueId)];
    for (const l of currentStateLabels) args.push("--remove-label", l);
    args.push("--add-label", to);
    await this.gh(args);
  }

  async addLabel(issueId: number, label: string): Promise<void> {
    await this.gh(["issue", "edit", String(issueId), "--add-label", label]);
  }

  async removeLabels(issueId: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return;
    const args = ["issue", "edit", String(issueId)];
    for (const l of labels) args.push("--remove-label", l);
    await this.gh(args);
  }

  async closeIssue(issueId: number): Promise<void> { await this.gh(["issue", "close", String(issueId)]); }
  async reopenIssue(issueId: number): Promise<void> { await this.gh(["issue", "reopen", String(issueId)]); }

  hasStateLabel(issue: Issue, expected: StateLabel): boolean { return issue.labels.includes(expected); }

  getCurrentStateLabel(issue: Issue): StateLabel | null {
    const stateLabels = getStateLabels(this.workflow);
    return stateLabels.find((l) => issue.labels.includes(l)) ?? null;
  }

  async hasMergedMR(issueId: number): Promise<boolean> {
    const prs = await this.findPrsForIssue(issueId, "merged", "title,body,headRefName");
    return prs.length > 0;
  }

  async getMergedMRUrl(issueId: number): Promise<string | null> {
    type MergedPr = { title: string; body: string; headRefName: string; url: string; mergedAt: string };
    const prs = await this.findPrsForIssue<MergedPr>(issueId, "merged", "title,body,headRefName,url,mergedAt");
    if (prs.length === 0) return null;
    prs.sort((a, b) => new Date(b.mergedAt).getTime() - new Date(a.mergedAt).getTime());
    return prs[0].url;
  }

  async getPrStatus(issueId: number): Promise<PrStatus> {
    // Check open PRs first
    type OpenPr = { title: string; body: string; headRefName: string; url: string; reviewDecision: string };
    const open = await this.findPrsForIssue<OpenPr>(issueId, "open", "title,body,headRefName,url,reviewDecision");
    if (open.length > 0) {
      const pr = open[0];
      const state = pr.reviewDecision === "APPROVED" ? PrState.APPROVED : PrState.OPEN;
      return { state, url: pr.url, title: pr.title, sourceBranch: pr.headRefName };
    }
    // Check merged PRs — also fetch reviewDecision to detect approved-then-merged vs self-merged.
    // A PR merged without any approvals (e.g. developer self-merge) returns PrState.MERGED but
    // reviewDecision will be null/"" (not "APPROVED"), so callers cannot treat it as approved.
    type MergedPr = { title: string; body: string; headRefName: string; url: string; reviewDecision: string | null };
    const merged = await this.findPrsForIssue<MergedPr>(issueId, "merged", "title,body,headRefName,url,reviewDecision");
    if (merged.length > 0) {
      const pr = merged[0];
      // If the PR was approved before merge, reflect that — heartbeat can distinguish approve+merge from self-merge.
      const state = pr.reviewDecision === "APPROVED" ? PrState.APPROVED : PrState.MERGED;
      return { state, url: pr.url, title: pr.title, sourceBranch: pr.headRefName };
    }
    return { state: PrState.CLOSED, url: null };
  }

  async mergePr(issueId: number): Promise<void> {
    type OpenPr = { title: string; body: string; headRefName: string; url: string };
    const prs = await this.findPrsForIssue<OpenPr>(issueId, "open", "title,body,headRefName,url");
    if (prs.length === 0) throw new Error(`No open PR found for issue #${issueId}`);
    await this.gh(["pr", "merge", prs[0].url, "--merge"]);
  }

  async getPrDiff(issueId: number): Promise<string | null> {
    type OpenPr = { title: string; body: string; headRefName: string; number: number };
    const prs = await this.findPrsForIssue<OpenPr>(issueId, "open", "title,body,headRefName,number");
    if (prs.length === 0) return null;
    try {
      return await this.gh(["pr", "diff", String(prs[0].number)]);
    } catch { return null; }
  }

  async addComment(issueId: number, body: string): Promise<void> {
    await this.gh(["issue", "comment", String(issueId), "--body", body]);
  }

  async editIssue(issueId: number, updates: { title?: string; body?: string }): Promise<Issue> {
    const args = ["issue", "edit", String(issueId)];
    if (updates.title !== undefined) args.push("--title", updates.title);
    if (updates.body !== undefined) args.push("--body", updates.body);
    await this.gh(args);
    return this.getIssue(issueId);
  }

  async healthCheck(): Promise<boolean> {
    try { await this.gh(["auth", "status"]); return true; } catch { return false; }
  }
}
