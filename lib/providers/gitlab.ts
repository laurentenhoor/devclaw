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

  async closeIssue(issueId: number): Promise<void> { await this.glab(["issue", "close", String(issueId)]); }
  async reopenIssue(issueId: number): Promise<void> { await this.glab(["issue", "reopen", String(issueId)]); }

  hasStateLabel(issue: Issue, expected: StateLabel): boolean { return issue.labels.includes(expected); }

  getCurrentStateLabel(issue: Issue): StateLabel | null {
    const stateLabels = getStateLabels(this.workflow);
    return stateLabels.find((l) => issue.labels.includes(l)) ?? null;
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

  async getPrStatus(issueId: number): Promise<PrStatus> {
    const pat = `#${issueId}`;
    // Check open MRs first
    try {
      const raw = await this.glab(["mr", "list", "--output", "json", "--state", "opened"]);
      const mrs = JSON.parse(raw) as Array<{ title: string; description: string; web_url: string; approved_by?: Array<unknown> }>;
      const mr = mrs.find((m) => m.title.includes(pat) || (m.description ?? "").includes(pat));
      if (mr) {
        const state = mr.approved_by && mr.approved_by.length > 0 ? PrState.APPROVED : PrState.OPEN;
        return { state, url: mr.web_url };
      }
    } catch { /* continue to merged check */ }
    // Check merged MRs
    try {
      const raw = await this.glab(["mr", "list", "--output", "json", "--state", "merged"]);
      const mrs = JSON.parse(raw) as Array<{ title: string; description: string; web_url: string }>;
      const mr = mrs.find((m) => m.title.includes(pat) || (m.description ?? "").includes(pat));
      if (mr) return { state: PrState.MERGED, url: mr.web_url };
    } catch { /* ignore */ }
    return { state: PrState.CLOSED, url: null };
  }

  async addComment(issueId: number, body: string): Promise<void> {
    // Pass message directly as argv — no shell escaping needed with spawn
    await this.glab(["issue", "note", String(issueId), "--message", body]);
  }

  async healthCheck(): Promise<boolean> {
    try { await this.glab(["auth", "status"]); return true; } catch { return false; }
  }
}
