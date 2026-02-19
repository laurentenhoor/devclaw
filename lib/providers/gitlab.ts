/**
 * GitLabProvider — IssueProvider implementation using glab CLI.
 */
import {
  type IssueProvider,
  type Issue,
  type StateLabel,
  type IssueComment,
  type PrStatus,
  type PrReviewComment,
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
  author?: { username: string };
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
    try {
      // Use GitLab API directly to create labels with color support.
      // The glab label create command may not properly pass color to the API,
      // so we use glab api to POST directly to /projects/:id/labels
      await this.glab([
        "api", "projects/:id/labels",
        "--field", `name=${name}`,
        "--field", `color=${color}`,
      ]);
    } catch (err) {
      const msg = (err as Error).message ?? "";
      // Ignore "already exists" and 409 Conflict errors
      if (!msg.includes("already exists") && !msg.includes("409")) throw err;
    }
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

  async listIssues(opts?: { label?: string; state?: "open" | "closed" | "all" }): Promise<Issue[]> {
    try {
      const args = ["issue", "list", "--output", "json"];
      if (opts?.label) args.push("--label", opts.label);
      if (opts?.state === "closed") args.push("--closed");
      else if (opts?.state === "all") args.push("--all");
      else args.push("--opened");
      const raw = await this.glab(args);
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
      const approved = await this.isMrApproved(open.iid);

      // Detect changes requested via unresolved discussion threads
      let state: PrState;
      if (approved) {
        state = PrState.APPROVED;
      } else {
        const hasUnresolved = await this.hasUnresolvedDiscussions(open.iid);
        if (hasUnresolved) {
          state = PrState.CHANGES_REQUESTED;
        } else {
          // Check for top-level conversation comments from non-author users
          const hasComments = await this.hasConversationComments(open.iid);
          state = hasComments ? PrState.HAS_COMMENTS : PrState.OPEN;
        }
      }

      // Detect merge conflicts
      const mergeable = await this.isMrMergeable(open.iid);

      return { state, url: open.web_url, title: open.title, sourceBranch: open.source_branch, mergeable };
    }
    // Check merged MRs
    const merged = mrs.find((mr) => mr.state === "merged");
    if (merged) return { state: PrState.MERGED, url: merged.web_url, title: merged.title, sourceBranch: merged.source_branch };
    return { state: PrState.CLOSED, url: null };
  }

  /** Check if an MR has unresolved discussion threads (proxy for changes requested). */
  private async hasUnresolvedDiscussions(mrIid: number): Promise<boolean> {
    try {
      const raw = await this.glab(["api", `projects/:id/merge_requests/${mrIid}/discussions`]);
      const discussions = JSON.parse(raw) as Array<{ notes: Array<{ resolvable: boolean; resolved: boolean; system: boolean }> }>;
      return discussions.some((d) =>
        d.notes.some((n) => n.resolvable && !n.resolved && !n.system),
      );
    } catch { return false; }
  }

  /**
   * Check if an MR has any top-level conversation notes from human users.
   * Excludes only system notes and empty bodies (author comments are included).
   * Uses the MR notes endpoint (regular comments, not threaded discussions).
   */
  private async hasConversationComments(mrIid: number): Promise<boolean> {
    try {
      const raw = await this.glab(["api", `projects/:id/merge_requests/${mrIid}/notes`]);
      const notes = JSON.parse(raw) as Array<{ id: number; system: boolean; body: string }>;
      const candidates = notes.filter((n) => !n.system && n.body.trim().length > 0);
      for (const note of candidates) {
        if (!(await this.noteHasEyesEmoji(mrIid, note.id))) return true;
      }
      return false;
    } catch { return false; }
  }

  /** Check if a note already has an 👀 award emoji (marks it as processed). */
  private async noteHasEyesEmoji(mrIid: number, noteId: number): Promise<boolean> {
    try {
      const raw = await this.glab(["api", `projects/:id/merge_requests/${mrIid}/notes/${noteId}/award_emoji`]);
      const emojis = JSON.parse(raw) as Array<{ name: string }>;
      return emojis.some((e) => e.name === "eyes");
    } catch { return false; }
  }

  /**
   * Fetch top-level conversation notes on an MR from human users.
   * Excludes only system notes and empty bodies.
   */
  private async fetchConversationComments(
    mrIid: number,
  ): Promise<Array<{ id: number; author: { username: string }; body: string; created_at: string }>> {
    try {
      const raw = await this.glab(["api", `projects/:id/merge_requests/${mrIid}/notes`]);
      const all = JSON.parse(raw) as Array<{ id: number; author: { username: string }; system: boolean; body: string; created_at: string }>;
      return all.filter(
        (n) => !n.system && n.body.trim().length > 0,
      );
    } catch { return []; }
  }

  /** Check MR merge status for conflicts. */
  private async isMrMergeable(mrIid: number): Promise<boolean | undefined> {
    try {
      const raw = await this.glab(["api", `projects/:id/merge_requests/${mrIid}?include_rebase_in_progress=true`]);
      const mr = JSON.parse(raw) as { has_conflicts?: boolean; detailed_merge_status?: string };
      if (mr.has_conflicts === true) return false;
      if (mr.detailed_merge_status === "conflict") return false;
      if (mr.detailed_merge_status === "mergeable" || mr.detailed_merge_status === "ci_must_pass") return true;
      return undefined; // Unknown
    } catch { return undefined; }
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
      // Only trust explicit approvals — ignore bare 'approved' flag.
      // When a project has zero approval rules, GitLab returns approved:true
      // even though nobody has actually reviewed, causing false positives.
      const hasExplicitApproval = Array.isArray(data.approved_by) && data.approved_by.length > 0;
      if (!hasExplicitApproval) return false;
      // All required approvals satisfied
      return (data.approvals_left ?? 1) <= 0;
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

  async getPrReviewComments(issueId: number): Promise<PrReviewComment[]> {
    const mrs = await this.getRelatedMRs(issueId);
    const open = mrs.find((mr) => mr.state === "opened");
    if (!open) return [];
    const comments: PrReviewComment[] = [];

    try {
      const raw = await this.glab(["api", `projects/:id/merge_requests/${open.iid}/discussions`]);
      const discussions = JSON.parse(raw) as Array<{
        notes: Array<{
          id: number; author: { username: string }; body: string;
          resolvable: boolean; resolved: boolean; system: boolean;
          created_at: string; position?: { new_path?: string; new_line?: number };
        }>;
      }>;

      for (const disc of discussions) {
        for (const note of disc.notes) {
          if (note.system) continue;
          comments.push({
            id: note.id,
            author: note.author.username,
            body: note.body,
            state: note.resolvable ? (note.resolved ? "RESOLVED" : "UNRESOLVED") : "COMMENTED",
            created_at: note.created_at,
            path: note.position?.new_path,
            line: note.position?.new_line ?? undefined,
          });
        }
      }
    } catch { /* best-effort */ }

    // Also include top-level conversation notes (regular MR comments, not threaded)
    const conversationNotes = await this.fetchConversationComments(open.iid);
    for (const n of conversationNotes) {
      // Avoid duplicates: discussions endpoint may already include these
      if (!comments.some((c) => c.id === n.id)) {
        comments.push({
          id: n.id,
          author: n.author.username,
          body: n.body,
          state: "COMMENTED",
          created_at: n.created_at,
        });
      }
    }

    comments.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    return comments;
  }

  async addComment(issueId: number, body: string): Promise<void> {
    // Pass message directly as argv — no shell escaping needed with spawn
    await this.glab(["issue", "note", String(issueId), "--message", body]);
  }

  /**
   * Add an emoji award (reaction) to an MR note/comment.
   * Uses the GitLab Award Emoji API on MR notes.
   * Best-effort — swallows all errors.
   * @param issueId  Used to locate the associated open MR via getRelatedMRs
   * @param commentId  The note ID on the MR
   * @param emoji  Emoji name without colons (e.g. "robot", "thumbsup")
   */
  async reactToPrComment(issueId: number, commentId: number, emoji: string): Promise<void> {
    try {
      const mrs = await this.getRelatedMRs(issueId);
      const open = mrs.find((mr) => mr.state === "opened");
      if (!open) return;
      await this.glab([
        "api", `projects/:id/merge_requests/${open.iid}/notes/${commentId}/award_emoji`,
        "--method", "POST",
        "--field", `name=${emoji}`,
      ]);
    } catch { /* best-effort */ }
  }

  async reactToPrReview(issueId: number, reviewId: number, emoji: string): Promise<void> {
    // GitLab doesn't distinguish reviews from comments — use the same note reaction API
    await this.reactToPrComment(issueId, reviewId, emoji);
  }

  async editIssue(issueId: number, updates: { title?: string; body?: string }): Promise<Issue> {
    const args = ["issue", "update", String(issueId)];
    if (updates.title !== undefined) args.push("--title", updates.title);
    if (updates.body !== undefined) args.push("--description", updates.body);
    await this.glab(args);
    return this.getIssue(issueId);
  }

  /**
   * Check if work for an issue is already present on the base branch via git log.
   * Searches the last 200 commits on baseBranch for commit messages mentioning #issueId or !issueId.
   * Used as a fallback when no MR exists (e.g., direct commit to main).
   */
  async isCommitOnBaseBranch(issueId: number, baseBranch: string): Promise<boolean> {
    try {
      // Search for issue references: #N (issue) or !N (MR) in commit messages
      const patterns = [`#${issueId}`, `!${issueId}`];
      for (const pattern of patterns) {
        const result = await runCommand(
          ["git", "log", `origin/${baseBranch}`, "--oneline", "-200", "--grep", pattern],
          { timeoutMs: 15_000, cwd: this.repoPath },
        );
        if (result.stdout.trim().length > 0) return true;
      }
      return false;
    } catch { return false; }
  }

  async healthCheck(): Promise<boolean> {
    try { await this.glab(["auth", "status"]); return true; } catch { return false; }
  }
}
