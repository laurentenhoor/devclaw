/**
 * GitLabProvider — IssueProvider implementation using glab CLI.
 */
import {
  type IssueProvider,
  type Issue,
  type StateLabel,
  STATE_LABELS,
  LABEL_COLORS,
} from "./provider.js";
import { runCommand } from "../run-command.js";

export class GitLabProvider implements IssueProvider {
  private repoPath: string;
  constructor(opts: { repoPath: string }) { this.repoPath = opts.repoPath; }

  private async glab(args: string[]): Promise<string> {
    const result = await runCommand(["glab", ...args], { timeoutMs: 30_000, cwd: this.repoPath });
    return result.stdout.trim();
  }

  async ensureLabel(name: string, color: string): Promise<void> {
    try { await this.glab(["label", "create", "--name", name, "--color", color]); }
    catch (err) { const msg = (err as Error).message ?? ""; if (!msg.includes("already exists") && !msg.includes("409")) throw err; }
  }

  async ensureAllStateLabels(): Promise<void> {
    for (const label of STATE_LABELS) await this.ensureLabel(label, LABEL_COLORS[label]);
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

  async transitionLabel(issueId: number, from: StateLabel, to: StateLabel): Promise<void> {
    const issue = await this.getIssue(issueId);
    const stateLabels = issue.labels.filter((l) => STATE_LABELS.includes(l as StateLabel));
    const args = ["issue", "update", String(issueId)];
    for (const l of stateLabels) args.push("--unlabel", l);
    args.push("--label", to);
    await this.glab(args);
  }

  async closeIssue(issueId: number): Promise<void> { await this.glab(["issue", "close", String(issueId)]); }
  async reopenIssue(issueId: number): Promise<void> { await this.glab(["issue", "reopen", String(issueId)]); }

  hasStateLabel(issue: Issue, expected: StateLabel): boolean { return issue.labels.includes(expected); }
  getCurrentStateLabel(issue: Issue): StateLabel | null {
    return STATE_LABELS.find((l) => issue.labels.includes(l)) ?? null;
  }

  async hasMergedMR(issueId: number): Promise<boolean> {
    try {
      const raw = await this.glab(["mr", "list", "--output", "json", "--state", "merged"]);
      const mrs = JSON.parse(raw) as Array<{ title: string; description: string }>;
      const pat = `#${issueId}`;
      return mrs.some((mr) => mr.title.includes(pat) || (mr.description ?? "").includes(pat));
    } catch { return false; }
  }

  async getMergedMRUrl(issueId: number): Promise<string | null> {
    try {
      const raw = await this.glab(["mr", "list", "--output", "json", "--state", "merged"]);
      const mrs = JSON.parse(raw) as Array<{ iid: number; title: string; description: string; web_url: string; merged_at: string }>;
      const pat = `#${issueId}`;
      const mr = mrs
        .filter((mr) => mr.title.includes(pat) || (mr.description ?? "").includes(pat))
        .sort((a, b) => new Date(b.merged_at).getTime() - new Date(a.merged_at).getTime())[0];
      return mr?.web_url ?? null;
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
