/**
 * GiteaProvider — Gitea (tea CLI) implementation of IssueProvider.
 *
 * tea CLI documentation: https://gitea.com/gitea/tea
 */
import type {
  Issue,
  IssueComment,
  IssueProvider,
  PrReviewComment,
  PrStatus,
  StateLabel,
} from "./provider.js";
import { PrState } from "./provider.js";
import { withResilience } from "./resilience.js";
import type { WorkflowConfig } from "../workflow.js";
import { getStateLabels, getLabelColors } from "../labels.js";
import { DEFAULT_WORKFLOW } from "../workflow.js";

export type GiteaProviderOpts = {
  repoPath: string;
  workflow?: WorkflowConfig;
  runCommand: (args: string[], opts: { timeoutMs?: number; cwd?: string }) => Promise<{
    stdout: string;
    stderr?: string;
    code?: number;
  }>;
};

export class GiteaProvider implements IssueProvider {
  private repoPath: string;
  private workflow: WorkflowConfig;
  private runCommand: GiteaProviderOpts["runCommand"];

  constructor(opts: GiteaProviderOpts) {
    this.repoPath = opts.repoPath;
    this.runCommand = opts.runCommand;
    this.workflow = opts.workflow ?? DEFAULT_WORKFLOW;
  }

  private async tea(args: string[]): Promise<string> {
    return withResilience(async () => {
      const result = await this.runCommand(["tea", ...args], { timeoutMs: 30_000, cwd: this.repoPath });
      return result.stdout.trim();
    });
  }

  async ensureLabel(name: string, color: string): Promise<void> {
    // tea doesn't have native label management via CLI.
    // We fail loudly here so that admin flows (project_register, sync_labels)
    // don't silently report success while required workflow labels are missing.
    throw new Error(
      `GiteaProvider cannot automatically ensure label "${name}" (${color}) in repo at "${this.repoPath}". ` +
      `Please create or update this label manually in Gitea (via web UI or API), then re-run the operation.`
    );
  }

  async ensureAllStateLabels(): Promise<void> {
    const labels = getStateLabels(this.workflow);
    const colors = getLabelColors(this.workflow);
    for (const label of labels) {
      await this.ensureLabel(label, colors[label]);
    }
  }

  async createIssue(
    title: string,
    description: string,
    label: StateLabel,
    assignees?: string[]
  ): Promise<Issue> {
    const args = ["issue", "create", "--title", title, "--description", description];
    if (label) args.push("--label", label);
    if (assignees?.length) args.push("--assignee", assignees.join(","));

    const stdout = await this.tea(args);
    // Parse issue number from output like: "#42 Issue title"
    const match = stdout.match(/#(\d+)/);
    if (!match) throw new Error(`Failed to parse issue ID: ${stdout}`);
    return this.getIssue(parseInt(match[1], 10));
  }

  async listIssuesByLabel(label: StateLabel): Promise<Issue[]> {
    try {
      const raw = await this.tea(["issue", "list", "--labels", label, "--output", "json"]);
      return this.parseIssues(raw);
    } catch {
      return [];
    }
  }

  async listIssues(opts?: { label?: string; state?: "open" | "closed" | "all" }): Promise<Issue[]> {
    try {
      const args = ["issue", "list", "--output", "json"];
      if (opts?.label) args.push("--labels", opts.label);
      if (opts?.state === "closed") {
        args.push("--closed");
      } else if (opts?.state === "open") {
        args.push("--open");
      } else if (opts?.state === "all") {
        args.push("--all");
      }

      const raw = await this.tea(args);
      return this.parseIssues(raw);
    } catch {
      return [];
    }
  }

  async getIssue(issueId: number): Promise<Issue> {
    const raw = await this.tea(["issue", "view", String(issueId), "--output", "json"]);
    return this.parseIssue(raw);
  }

  async listComments(issueId: number): Promise<IssueComment[]> {
    // tea doesn't support listing comments via CLI
    // Could be implemented via API if needed
    return [];
  }

  async transitionLabel(issueId: number, from: StateLabel, to: StateLabel): Promise<void> {
    // Get current issue to preserve non-state labels
    const issue = await this.getIssue(issueId);
    const stateLabels = getStateLabels(this.workflow);

    // Build new labels: keep non-state labels, add new state label
    const nonStateLabels = issue.labels.filter((l: string) => !stateLabels.includes(l));
    const newLabels = [...nonStateLabels, to];

    await this.tea(["issue", "update", String(issueId), "--labels", newLabels.join(",")]);
  }

  async addLabel(issueId: number, label: string): Promise<void> {
    const issue = await this.getIssue(issueId);
    const labels = [...new Set([...issue.labels, label])];
    await this.tea(["issue", "update", String(issueId), "--labels", labels.join(",")]);
  }

  async removeLabels(issueId: number, labels: string[]): Promise<void> {
    const issue = await this.getIssue(issueId);
    const newLabels = issue.labels.filter((l: string) => !labels.includes(l));
    await this.tea(["issue", "update", String(issueId), "--labels", newLabels.join(",")]);
  }

  async closeIssue(issueId: number): Promise<void> {
    await this.tea(["issue", "close", String(issueId)]);
  }

  async reopenIssue(issueId: number): Promise<void> {
    // Best-effort reopen: try via tea CLI, but don't fail the workflow if unsupported.
    try {
      await this.tea(["issue", "reopen", String(issueId)]);
    } catch {
      // Reopen not supported or failed; ignore to keep failure loop functional.
    }
  }

  async getMergedMRUrl(issueId: number): Promise<string | null> {
    // tea doesn't have PR linking like GitLab
    // Search merged PRs mentioning the issue
    try {
      const raw = await this.tea(["pull", "list", "--output", "json"]);
      const prs = JSON.parse(raw);
      // Find merged PRs that mention this issue
      const mentioningPr = prs.find((pr: any) =>
        pr.state === "merged" && (
          pr.body?.includes(`#${issueId}`) ||
          pr.title?.includes(`#${issueId}`)
        )
      );
      return mentioningPr?.html_url ?? null;
    } catch {
      return null;
    }
  }

  async getPrStatus(issueId: number): Promise<PrStatus> {
    try {
      // Search for PRs mentioning this issue
      const raw = await this.tea(["pull", "list", "--output", "json"]);
      const prs = JSON.parse(raw);
      const pr = prs.find((p: any) =>
        p.body?.includes(`#${issueId}`) ||
        p.title?.includes(`#${issueId}`)
      );

      if (!pr) {
        return { state: PrState.OPEN, url: null };
      }

      const state = pr.state === "merged" ? PrState.MERGED :
        pr.state === "closed" ? PrState.CLOSED :
        PrState.OPEN;

      return {
        state,
        url: pr.html_url,
        title: pr.title,
        sourceBranch: pr.head?.ref,
        mergeable: pr.mergeable,
      };
    } catch {
      return { state: PrState.OPEN, url: null };
    }
  }

  async mergePr(issueId: number): Promise<void> {
    // Find PR mentioning the issue
    const raw = await this.tea(["pull", "list", "--output", "json"]);
    const prs = JSON.parse(raw);
    const pr = prs.find((p: any) =>
      p.body?.includes(`#${issueId}`) ||
      p.title?.includes(`#${issueId}`)
    );

    if (!pr) {
      throw new Error(`No PR found for issue #${issueId}`);
    }

    await this.tea(["pull", "merge", String(pr.number)]);
  }

  async getPrDiff(issueId: number): Promise<string | null> {
    try {
      const raw = await this.tea(["pull", "list", "--output", "json"]);
      const prs = JSON.parse(raw);
      const pr = prs.find((p: any) =>
        p.body?.includes(`#${issueId}`) ||
        p.title?.includes(`#${issueId}`)
      );

      if (!pr) return null;

      const diff = await this.tea(["pull", "diff", String(pr.number)]);
      return diff;
    } catch {
      return null;
    }
  }

  async getPrReviewComments(issueId: number): Promise<PrReviewComment[]> {
    // tea doesn't support review comments via CLI
    return [];
  }

  async isCommitOnBaseBranch(issueId: number, baseBranch: string): Promise<boolean> {
    try {
      const result = await this.runCommand(
        ["git", "log", baseBranch, "--oneline", "-20", `--grep=#${issueId}`],
        { timeoutMs: 10_000, cwd: this.repoPath }
      );
      return result.stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  async reactToIssue(issueId: number, emoji: string): Promise<void> {
    // tea doesn't support reactions via CLI
    // No-op - reactions are optional (best-effort)
  }

  async issueHasReaction(issueId: number, emoji: string): Promise<boolean> {
    return false;
  }

  async reactToPr(issueId: number, emoji: string): Promise<void> {
    // No-op
  }

  async prHasReaction(issueId: number, emoji: string): Promise<boolean> {
    return false;
  }

  async reactToIssueComment(issueId: number, commentId: number, emoji: string): Promise<void> {
    // No-op
  }

  async reactToPrComment(issueId: number, commentId: number, emoji: string): Promise<void> {
    // No-op
  }

  async reactToPrReview(issueId: number, reviewId: number, emoji: string): Promise<void> {
    // No-op
  }

  async issueCommentHasReaction(issueId: number, commentId: number, emoji: string): Promise<boolean> {
    return false;
  }

  async prCommentHasReaction(issueId: number, commentId: number, emoji: string): Promise<boolean> {
    return false;
  }

  async prReviewHasReaction(issueId: number, reviewId: number, emoji: string): Promise<boolean> {
    return false;
  }

  async addComment(issueId: number, body: string): Promise<number> {
    // Use tea CLI to add a comment to an issue.
    // Note: comment ID is not parsed from output here; callers that rely on
    // the side-effect (the comment being created) can proceed without it.
    await this.tea(["issue", "comment", "create", String(issueId), "--body", body]);
    return 0;
  }

  async editIssue(issueId: number, updates: { title?: string; body?: string }): Promise<Issue> {
    const args = ["issue", "update", String(issueId)];
    if (updates.title) args.push("--title", updates.title);
    if (updates.body) args.push("--description", updates.body);

    await this.tea(args);
    return this.getIssue(issueId);
  }

  async uploadAttachment(
    issueId: number,
    file: { filename: string; buffer: Buffer; mimeType: string }
  ): Promise<string | null> {
    // tea doesn't support file uploads via CLI
    return null;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.tea(["--version"]);
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Helper methods
  // -------------------------------------------------------------------------

  private parseIssues(json: string): Issue[] {
    const data = JSON.parse(json);
    if (!Array.isArray(data)) return [];
    return data.map((item: any) => this.toIssue(item));
  }

  private parseIssue(json: string): Issue {
    return this.toIssue(JSON.parse(json));
  }

  private toIssue(data: any): Issue {
    return {
      iid: data.number ?? data.index ?? 0,
      title: data.title ?? "",
      description: data.body ?? data.content ?? "",
      labels: Array.isArray(data.labels) ? data.labels.map((l: any) =>
        typeof l === "string" ? l : l.name
      ) : [],
      state: data.state ?? "open",
      web_url: data.html_url ?? data.url ?? "",
    };
  }
}
