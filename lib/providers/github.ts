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

  async closeIssue(issueId: number): Promise<void> { await this.gh(["issue", "close", String(issueId)]); }
  async reopenIssue(issueId: number): Promise<void> { await this.gh(["issue", "reopen", String(issueId)]); }

  hasStateLabel(issue: Issue, expected: StateLabel): boolean { return issue.labels.includes(expected); }

  getCurrentStateLabel(issue: Issue): StateLabel | null {
    const stateLabels = getStateLabels(this.workflow);
    return stateLabels.find((l) => issue.labels.includes(l)) ?? null;
  }

  async hasMergedMR(issueId: number): Promise<boolean> {
    try {
      const raw = await this.gh(["pr", "list", "--state", "merged", "--json", "title,body"]);
      const prs = JSON.parse(raw) as Array<{ title: string; body: string }>;
      const pat = `#${issueId}`;
      return prs.some((pr) => pr.title.includes(pat) || (pr.body ?? "").includes(pat));
    } catch { return false; }
  }

  async getMergedMRUrl(issueId: number): Promise<string | null> {
    try {
      const raw = await this.gh(["pr", "list", "--state", "merged", "--json", "number,title,body,url,mergedAt", "--limit", "20"]);
      const prs = JSON.parse(raw) as Array<{ number: number; title: string; body: string; url: string; mergedAt: string }>;
      const pat = `#${issueId}`;
      return prs.find((pr) => pr.title.includes(pat) || (pr.body ?? "").includes(pat))?.url ?? null;
    } catch { return null; }
  }

  async getPrStatus(issueId: number): Promise<PrStatus> {
    const pat = `#${issueId}`;
    // Check open PRs first
    try {
      const raw = await this.gh(["pr", "list", "--state", "open", "--json", "title,body,url,reviewDecision", "--limit", "20"]);
      const prs = JSON.parse(raw) as Array<{ title: string; body: string; url: string; reviewDecision: string }>;
      const pr = prs.find((p) => p.title.includes(pat) || (p.body ?? "").includes(pat));
      if (pr) {
        const state = pr.reviewDecision === "APPROVED" ? PrState.APPROVED : PrState.OPEN;
        return { state, url: pr.url };
      }
    } catch { /* continue to merged check */ }
    // Check merged PRs
    try {
      const raw = await this.gh(["pr", "list", "--state", "merged", "--json", "title,body,url", "--limit", "20"]);
      const prs = JSON.parse(raw) as Array<{ title: string; body: string; url: string }>;
      const pr = prs.find((p) => p.title.includes(pat) || (p.body ?? "").includes(pat));
      if (pr) return { state: PrState.MERGED, url: pr.url };
    } catch { /* ignore */ }
    return { state: PrState.CLOSED, url: null };
  }

  async addComment(issueId: number, body: string): Promise<void> {
    await this.gh(["issue", "comment", String(issueId), "--body", body]);
  }

  async healthCheck(): Promise<boolean> {
    try { await this.gh(["auth", "status"]); return true; } catch { return false; }
  }
}
