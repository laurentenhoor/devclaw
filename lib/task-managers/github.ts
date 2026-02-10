/**
 * GitHubProvider — IssueProvider implementation using gh CLI.
 *
 * Wraps gh commands for label management, issue operations, and PR checks.
 * ensureLabel is idempotent — catches "already exists" errors gracefully.
 *
 * Note: gh CLI JSON output uses different field names than GitLab:
 *   number (not iid), body (not description), url (not web_url),
 *   labels are objects with { name } (not plain strings).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  type TaskManager,
  type Issue,
  type StateLabel,
  STATE_LABELS,
  LABEL_COLORS,
} from "./task-manager.js";

const execFileAsync = promisify(execFile);

export type GitHubProviderOptions = {
  repoPath: string;
};

type GhIssue = {
  number: number;
  title: string;
  body: string;
  labels: Array<{ name: string }>;
  state: string;
  url: string;
};

/** Convert gh JSON issue to the common Issue type. */
function toIssue(gh: GhIssue): Issue {
  return {
    iid: gh.number,
    title: gh.title,
    description: gh.body ?? "",
    labels: gh.labels.map((l) => l.name),
    state: gh.state,
    web_url: gh.url,
  };
}

export class GitHubProvider implements TaskManager {
  private repoPath: string;

  constructor(opts: GitHubProviderOptions) {
    this.repoPath = opts.repoPath;
  }

  private async gh(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("gh", args, {
      cwd: this.repoPath,
      timeout: 30_000,
    });
    return stdout.trim();
  }

  async ensureLabel(name: string, color: string): Promise<void> {
    // gh expects color without # prefix
    const hex = color.replace(/^#/, "");
    try {
      await this.gh(["label", "create", name, "--color", hex]);
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (msg.includes("already exists")) {
        return;
      }
      throw err;
    }
  }

  async ensureAllStateLabels(): Promise<void> {
    for (const label of STATE_LABELS) {
      await this.ensureLabel(label, LABEL_COLORS[label]);
    }
  }

  async createIssue(
    title: string,
    description: string,
    label: StateLabel,
    assignees?: string[],
  ): Promise<Issue> {
    // Write description to temp file to preserve newlines
    const tempFile = join(tmpdir(), `devclaw-issue-${Date.now()}.md`);
    await writeFile(tempFile, description, "utf-8");

    try {
      const args = [
        "issue", "create",
        "--title", title,
        "--body-file", tempFile,
        "--label", label,
      ];
      if (assignees && assignees.length > 0) {
        args.push("--assignee", assignees.join(","));
      }
      // gh issue create returns the URL of the created issue
      const url = await this.gh(args);
      // Extract issue number from URL (e.g., https://github.com/owner/repo/issues/42)
      const match = url.match(/\/issues\/(\d+)$/);
      if (!match) {
        throw new Error(`Failed to parse issue number from created issue URL: ${url}`);
      }
      const issueId = parseInt(match[1], 10);
      // Fetch the full issue details
      return this.getIssue(issueId);
    } finally {
      // Clean up temp file
      try {
        await unlink(tempFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  async listIssuesByLabel(label: StateLabel): Promise<Issue[]> {
    try {
      const raw = await this.gh([
        "issue", "list",
        "--label", label,
        "--state", "open",
        "--json", "number,title,body,labels,state,url",
      ]);
      const issues = JSON.parse(raw) as GhIssue[];
      return issues.map(toIssue);
    } catch {
      return [];
    }
  }

  async getIssue(issueId: number): Promise<Issue> {
    const raw = await this.gh([
      "issue", "view", String(issueId),
      "--json", "number,title,body,labels,state,url",
    ]);
    return toIssue(JSON.parse(raw) as GhIssue);
  }

  async transitionLabel(
    issueId: number,
    from: StateLabel,
    to: StateLabel,
  ): Promise<void> {
    // Fetch current issue to get all labels
    const issue = await this.getIssue(issueId);
    
    // Find all state labels currently on the issue
    const currentStateLabels = issue.labels.filter((label) =>
      STATE_LABELS.includes(label as StateLabel),
    );
    
    // If no state labels to remove, just add the new one
    if (currentStateLabels.length === 0) {
      await this.gh([
        "issue", "edit", String(issueId),
        "--add-label", to,
      ]);
      return;
    }
    
    // Remove all state labels and add the new one in a single operation
    // This ensures clean transitions: "removed X, added Y" instead of messy multi-label operations
    const args = [
      "issue", "edit", String(issueId),
    ];
    
    // Add all current state labels to remove
    for (const label of currentStateLabels) {
      args.push("--remove-label", label);
    }
    
    // Add the new state label
    args.push("--add-label", to);
    
    await this.gh(args);
  }

  async closeIssue(issueId: number): Promise<void> {
    await this.gh(["issue", "close", String(issueId)]);
  }

  async reopenIssue(issueId: number): Promise<void> {
    await this.gh(["issue", "reopen", String(issueId)]);
  }

  hasStateLabel(issue: Issue, expected: StateLabel): boolean {
    return issue.labels.includes(expected);
  }

  getCurrentStateLabel(issue: Issue): StateLabel | null {
    for (const label of STATE_LABELS) {
      if (issue.labels.includes(label)) {
        return label;
      }
    }
    return null;
  }

  async hasMergedMR(issueId: number): Promise<boolean> {
    try {
      const raw = await this.gh([
        "pr", "list",
        "--state", "merged",
        "--json", "title,body",
      ]);
      const prs = JSON.parse(raw) as Array<{ title: string; body: string }>;
      const pattern = `#${issueId}`;
      return prs.some(
        (pr) =>
          pr.title.includes(pattern) || (pr.body ?? "").includes(pattern),
      );
    } catch {
      return false;
    }
  }

  async getMergedMRUrl(issueId: number): Promise<string | null> {
    try {
      const raw = await this.gh([
        "pr", "list",
        "--state", "merged",
        "--json", "number,title,body,url,mergedAt",
        "--limit", "20",
      ]);
      const prs = JSON.parse(raw) as Array<{
        number: number;
        title: string;
        body: string;
        url: string;
        mergedAt: string;
      }>;
      
      const pattern = `#${issueId}`;
      
      // Find the most recently merged PR that references this issue
      // PRs are returned in reverse chronological order by default
      const matchingPr = prs.find(
        (pr) =>
          pr.title.includes(pattern) || (pr.body ?? "").includes(pattern),
      );
      
      return matchingPr?.url ?? null;
    } catch {
      return null;
    }
  }

  async addComment(issueId: number, body: string): Promise<void> {
    // Write body to temp file to preserve newlines
    const tempFile = join(tmpdir(), `devclaw-comment-${Date.now()}.md`);
    await writeFile(tempFile, body, "utf-8");

    try {
      await this.gh([
        "issue", "comment", String(issueId),
        "--body-file", tempFile,
      ]);
    } finally {
      // Clean up temp file
      try {
        await unlink(tempFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.gh(["auth", "status"]);
      return true;
    } catch {
      return false;
    }
  }
}
