/**
 * GitHubProvider — IssueProvider implementation using gh CLI.
 */
import {
  type IssueProvider,
  type Issue,
  type StateLabel,
  STATE_LABELS,
  LABEL_COLORS,
} from "./provider.js";
import { runCommand } from "../run-command.js";

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
  constructor(opts: { repoPath: string }) { this.repoPath = opts.repoPath; }

  private async gh(args: string[]): Promise<string> {
    const result = await runCommand(["gh", ...args], { timeoutMs: 30_000, cwd: this.repoPath });
    return result.stdout.trim();
  }

  async ensureLabel(name: string, color: string): Promise<void> {
    try { await this.gh(["label", "create", name, "--color", color.replace(/^#/, "")]); }
    catch (err) { if (!(err as Error).message?.includes("already exists")) throw err; }
  }

  async ensureAllStateLabels(): Promise<void> {
    for (const label of STATE_LABELS) await this.ensureLabel(label, LABEL_COLORS[label]);
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

  async transitionLabel(issueId: number, from: StateLabel, to: StateLabel): Promise<void> {
    const issue = await this.getIssue(issueId);
    const stateLabels = issue.labels.filter((l) => STATE_LABELS.includes(l as StateLabel));
    const args = ["issue", "edit", String(issueId)];
    for (const l of stateLabels) args.push("--remove-label", l);
    args.push("--add-label", to);
    await this.gh(args);
  }

  async closeIssue(issueId: number): Promise<void> { await this.gh(["issue", "close", String(issueId)]); }
  async reopenIssue(issueId: number): Promise<void> { await this.gh(["issue", "reopen", String(issueId)]); }

  hasStateLabel(issue: Issue, expected: StateLabel): boolean { return issue.labels.includes(expected); }
  getCurrentStateLabel(issue: Issue): StateLabel | null {
    return STATE_LABELS.find((l) => issue.labels.includes(l)) ?? null;
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

  async addComment(issueId: number, body: string): Promise<void> {
    await this.gh(["issue", "comment", String(issueId), "--body", body]);
  }

  async healthCheck(): Promise<boolean> {
    try { await this.gh(["auth", "status"]); return true; } catch { return false; }
  }
}
