/**
 * GitHubProvider — IssueProvider implementation using gh CLI.
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

  /** Cached repo owner/name for GraphQL queries. */
  private repoInfo: { owner: string; name: string } | null | undefined = undefined;

  /**
   * Get repo owner and name via gh CLI. Cached per instance.
   * Returns null if unavailable (no git remote, etc.).
   */
  private async getRepoInfo(): Promise<{ owner: string; name: string } | null> {
    if (this.repoInfo !== undefined) return this.repoInfo;
    try {
      const raw = await this.gh(["repo", "view", "--json", "owner,name"]);
      const data = JSON.parse(raw);
      this.repoInfo = { owner: data.owner.login, name: data.name };
    } catch {
      this.repoInfo = null;
    }
    return this.repoInfo;
  }

  /**
   * Find PRs linked to an issue via GitHub's timeline API (GraphQL).
   * This catches PRs regardless of branch naming convention.
   * Returns null if GraphQL query fails (caller should fall back).
   */
  private async findPrsViaTimeline(
    issueId: number,
    state: "open" | "merged" | "all",
  ): Promise<Array<{ number: number; title: string; body: string; headRefName: string; url: string; mergedAt: string | null; reviewDecision: string | null }> | null> {
    const repo = await this.getRepoInfo();
    if (!repo) return null;

    try {
      const query = `{
        repository(owner: "${repo.owner}", name: "${repo.name}") {
          issue(number: ${issueId}) {
            timelineItems(itemTypes: [CONNECTED_EVENT, CROSS_REFERENCED_EVENT], first: 20) {
              nodes {
                __typename
                ... on ConnectedEvent {
                  subject { ... on PullRequest { number title body headRefName state url mergedAt reviewDecision } }
                }
                ... on CrossReferencedEvent {
                  source { ... on PullRequest { number title body headRefName state url mergedAt reviewDecision } }
                }
              }
            }
          }
        }
      }`;

      const raw = await this.gh(["api", "graphql", "-f", `query=${query}`]);
      const data = JSON.parse(raw);
      const nodes = data?.data?.repository?.issue?.timelineItems?.nodes ?? [];

      // Extract PR data from both event types
      const seen = new Set<number>();
      const prs: Array<{ number: number; title: string; body: string; headRefName: string; url: string; mergedAt: string | null; reviewDecision: string | null; state: string }> = [];

      for (const node of nodes) {
        const pr = node.subject ?? node.source;
        if (!pr?.number || !pr?.url) continue; // Not a PR or empty source
        if (seen.has(pr.number)) continue;
        seen.add(pr.number);
        prs.push({
          number: pr.number,
          title: pr.title ?? "",
          body: pr.body ?? "",
          headRefName: pr.headRefName ?? "",
          url: pr.url,
          mergedAt: pr.mergedAt ?? null,
          reviewDecision: pr.reviewDecision ?? null,
          state: pr.state ?? "",
        });
      }

      // Filter by state
      if (state === "open") return prs.filter((pr) => pr.state === "OPEN");
      if (state === "merged") return prs.filter((pr) => pr.state === "MERGED");
      return prs;
    } catch {
      return null; // GraphQL failed — caller should fall back
    }
  }

  /**
   * Find PRs associated with an issue.
   * Primary: GitHub timeline API (convention-free, catches all linked PRs).
   * Fallback: regex matching on branch name / title / body.
   */
  private async findPrsForIssue<T extends { title: string; body: string; headRefName?: string }>(
    issueId: number,
    state: "open" | "merged" | "all",
    fields: string,
  ): Promise<T[]> {
    // Try timeline API first (returns all linked PRs regardless of naming convention)
    const timelinePrs = await this.findPrsViaTimeline(issueId, state);
    if (timelinePrs && timelinePrs.length > 0) {
      // Map timeline results to the expected shape (T includes the requested fields)
      return timelinePrs as unknown as T[];
    }

    // Fallback: regex-based matching on branch name / title / body
    try {
      const args = ["pr", "list", "--json", fields, "--limit", "50"];
      if (state !== "all") args.push("--state", state);
      const raw = await this.gh(args);
      if (!raw) return [];
      const prs = JSON.parse(raw) as T[];
      const branchPat = new RegExp(`^(?:fix|feat|feature|chore|bugfix|hotfix|refactor|docs|test)/${issueId}-`);
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

  async getMergedMRUrl(issueId: number): Promise<string | null> {
    type MergedPr = { title: string; body: string; headRefName: string; url: string; mergedAt: string };
    const prs = await this.findPrsForIssue<MergedPr>(issueId, "merged", "title,body,headRefName,url,mergedAt");
    if (prs.length === 0) return null;
    prs.sort((a, b) => new Date(b.mergedAt).getTime() - new Date(a.mergedAt).getTime());
    return prs[0].url;
  }

  async getPrStatus(issueId: number): Promise<PrStatus> {
    // Check open PRs first — include mergeable for conflict detection
    type OpenPr = { title: string; body: string; headRefName: string; url: string; number: number; reviewDecision: string; mergeable: string };
    const open = await this.findPrsForIssue<OpenPr>(issueId, "open", "title,body,headRefName,url,number,reviewDecision,mergeable");
    if (open.length > 0) {
      const pr = open[0];
      let state: PrState;
      if (pr.reviewDecision === "APPROVED") {
        state = PrState.APPROVED;
      } else if (pr.reviewDecision === "CHANGES_REQUESTED") {
        state = PrState.CHANGES_REQUESTED;
      } else {
        // No branch protection → reviewDecision may be empty. Check individual reviews.
        const hasChangesRequested = await this.hasChangesRequestedReview(pr.number);
        if (hasChangesRequested) {
          state = PrState.CHANGES_REQUESTED;
        } else {
          // Fall through to conversation comment detection
          const prAuthor = await this.getPrAuthor(pr.number);
          const hasComments = await this.hasConversationComments(pr.number, prAuthor);
          state = hasComments ? PrState.HAS_COMMENTS : PrState.OPEN;
        }
      }

      // Conflict detection: "CONFLICTING" means merge conflicts, "UNKNOWN" means still computing
      const mergeable = pr.mergeable === "CONFLICTING" ? false
        : pr.mergeable === "MERGEABLE" ? true
        : undefined; // UNKNOWN or missing — don't assume

      return { state, url: pr.url, title: pr.title, sourceBranch: pr.headRefName, mergeable };
    }
    // Check merged PRs — also fetch reviewDecision to detect approved-then-merged vs self-merged.
    type MergedPr = { title: string; body: string; headRefName: string; url: string; reviewDecision: string | null };
    const merged = await this.findPrsForIssue<MergedPr>(issueId, "merged", "title,body,headRefName,url,reviewDecision");
    if (merged.length > 0) {
      const pr = merged[0];
      const state = pr.reviewDecision === "APPROVED" ? PrState.APPROVED : PrState.MERGED;
      return { state, url: pr.url, title: pr.title, sourceBranch: pr.headRefName };
    }
    return { state: PrState.CLOSED, url: null };
  }

  /**
   * Check individual reviews for CHANGES_REQUESTED state.
   * Used when branch protection is disabled (reviewDecision is empty).
   */
  private async hasChangesRequestedReview(prNumber: number): Promise<boolean> {
    try {
      const raw = await this.gh(["api", `repos/:owner/:repo/pulls/${prNumber}/reviews`, "--jq",
        "[.[] | select(.state == \"CHANGES_REQUESTED\" or .state == \"APPROVED\") | {user: .user.login, state}] | group_by(.user) | map(sort_by(.state) | last) | .[] | select(.state == \"CHANGES_REQUESTED\") | .user"]);
      return raw.trim().length > 0;
    } catch { return false; }
  }

  /** Fetch the login of the PR author. Returns empty string on error. */
  private async getPrAuthor(prNumber: number): Promise<string> {
    try {
      const raw = await this.gh(["api", `repos/:owner/:repo/pulls/${prNumber}`, "--jq", ".user.login"]);
      return raw.trim();
    } catch { return ""; }
  }

  /**
   * Check if a PR has top-level conversation comments from non-author users.
   * Uses the Issues Comments API (PRs are also issues in GitHub).
   */
  private async hasConversationComments(prNumber: number, prAuthor: string): Promise<boolean> {
    try {
      const raw = await this.gh(["api", `repos/:owner/:repo/issues/${prNumber}/comments`]);
      const comments = JSON.parse(raw) as Array<{ user: { login: string }; body: string }>;
      return comments.some(
        (c) => c.user.login !== prAuthor && !c.user.login.endsWith("[bot]") && c.body.trim().length > 0,
      );
    } catch { return false; }
  }

  /**
   * Fetch top-level conversation comments on a PR from non-author users.
   * These are comments on the PR timeline (not inline review comments).
   */
  private async fetchConversationComments(
    prNumber: number,
    prAuthor: string,
  ): Promise<Array<{ id: number; user: { login: string }; body: string; created_at: string }>> {
    try {
      const raw = await this.gh(["api", `repos/:owner/:repo/issues/${prNumber}/comments`]);
      const all = JSON.parse(raw) as Array<{ id: number; user: { login: string }; body: string; created_at: string }>;
      return all.filter(
        (c) => c.user.login !== prAuthor && !c.user.login.endsWith("[bot]") && c.body.trim().length > 0,
      );
    } catch { return []; }
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

  async getPrReviewComments(issueId: number): Promise<PrReviewComment[]> {
    type OpenPr = { title: string; body: string; headRefName: string; number: number; author: { login: string } };
    const prs = await this.findPrsForIssue<OpenPr>(issueId, "open", "title,body,headRefName,number,author");
    if (prs.length === 0) return [];
    const prNumber = prs[0].number;
    const prAuthor = (prs[0] as any).author?.login ?? "";
    const comments: PrReviewComment[] = [];

    try {
      // Review-level comments (top-level reviews: APPROVED, CHANGES_REQUESTED, COMMENTED)
      const reviewsRaw = await this.gh(["api", `repos/:owner/:repo/pulls/${prNumber}/reviews`]);
      const reviews = JSON.parse(reviewsRaw) as Array<{
        id: number; user: { login: string }; body: string; state: string; submitted_at: string;
      }>;
      for (const r of reviews) {
        if (r.user.login === prAuthor) continue; // Skip self-reviews
        if (r.state === "DISMISSED") continue; // Skip dismissed
        if (!r.body && r.state === "COMMENTED") continue; // Skip empty COMMENTED reviews
        comments.push({
          id: r.id,
          author: r.user.login,
          body: r.body ?? "",
          state: r.state,
          created_at: r.submitted_at,
        });
      }
    } catch { /* best-effort */ }

    try {
      // Inline (file-level) review comments
      const inlineRaw = await this.gh(["api", `repos/:owner/:repo/pulls/${prNumber}/comments`]);
      const inlines = JSON.parse(inlineRaw) as Array<{
        id: number; user: { login: string }; body: string; path: string; line: number | null; created_at: string;
      }>;
      for (const c of inlines) {
        if (c.user.login === prAuthor) continue;
        comments.push({
          id: c.id,
          author: c.user.login,
          body: c.body,
          state: "INLINE",
          created_at: c.created_at,
          path: c.path,
          line: c.line ?? undefined,
        });
      }
    } catch { /* best-effort */ }

    // Top-level conversation comments (regular PR comments via Issues API)
    const conversationComments = await this.fetchConversationComments(prNumber, prAuthor);
    for (const c of conversationComments) {
      comments.push({
        id: c.id,
        author: c.user.login,
        body: c.body,
        state: "COMMENTED",
        created_at: c.created_at,
      });
    }

    // Sort by date
    comments.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    return comments;
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
