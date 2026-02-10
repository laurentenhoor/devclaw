/**
 * GitLabProvider — IssueProvider implementation using glab CLI.
 *
 * Wraps glab commands for label management, issue operations, and MR checks.
 * ensureLabel is idempotent — catches "already exists" errors gracefully.
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

export type GitLabProviderOptions = {
  repoPath: string;
};

export class GitLabProvider implements TaskManager {
  private repoPath: string;

  constructor(opts: GitLabProviderOptions) {
    this.repoPath = opts.repoPath;
  }

  private async glab(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("glab", args, {
      cwd: this.repoPath,
      timeout: 30_000,
    });
    return stdout.trim();
  }

  async ensureLabel(name: string, color: string): Promise<void> {
    try {
      await this.glab(["label", "create", "--name", name, "--color", color]);
    } catch (err) {
      const msg = (err as Error).message ?? "";
      // Idempotent: ignore "already exists" errors
      if (msg.includes("already exists") || msg.includes("409")) {
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
      // Use shell to read file content into description
      const { exec } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execAsync = promisify(exec);

      let cmd = `glab issue create --title "${title.replace(/"/g, '\\"')}" --description "$(cat ${tempFile})" --label "${label}" --output json`;
      if (assignees && assignees.length > 0) {
        cmd += ` --assignee "${assignees.join(",")}"`;
      }

      const { stdout } = await execAsync(cmd, {
        cwd: this.repoPath,
        timeout: 30_000,
      });
      return JSON.parse(stdout.trim()) as Issue;
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
      const raw = await this.glab([
        "issue", "list", "--label", label, "--output", "json",
      ]);
      return JSON.parse(raw) as Issue[];
    } catch {
      return [];
    }
  }

  async getIssue(issueId: number): Promise<Issue> {
    const raw = await this.glab([
      "issue", "view", String(issueId), "--output", "json",
    ]);
    return JSON.parse(raw) as Issue;
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
      await this.glab([
        "issue", "update", String(issueId),
        "--label", to,
      ]);
      return;
    }
    
    // Remove all state labels and add the new one in a single operation
    // This ensures clean transitions: "removed X, added Y" instead of messy multi-label operations
    const args = [
      "issue", "update", String(issueId),
    ];
    
    // Add all current state labels to remove
    for (const label of currentStateLabels) {
      args.push("--unlabel", label);
    }
    
    // Add the new state label
    args.push("--label", to);
    
    await this.glab(args);
  }

  async closeIssue(issueId: number): Promise<void> {
    await this.glab(["issue", "close", String(issueId)]);
  }

  async reopenIssue(issueId: number): Promise<void> {
    await this.glab(["issue", "reopen", String(issueId)]);
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
      const raw = await this.glab([
        "mr", "list", "--output", "json", "--state", "merged",
      ]);
      const mrs = JSON.parse(raw) as Array<{ title: string; description: string }>;
      const pattern = `#${issueId}`;
      return mrs.some(
        (mr) =>
          mr.title.includes(pattern) || (mr.description ?? "").includes(pattern),
      );
    } catch {
      return false;
    }
  }

  async addComment(issueId: number, body: string): Promise<void> {
    // Write body to temp file to preserve newlines
    const tempFile = join(tmpdir(), `devclaw-comment-${Date.now()}.md`);
    await writeFile(tempFile, body, "utf-8");

    try {
      const { exec } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execAsync = promisify(exec);

      const cmd = `glab issue note ${issueId} --message "$(cat ${tempFile})"`;
      await execAsync(cmd, {
        cwd: this.repoPath,
        timeout: 30_000,
      });
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
      await this.glab(["auth", "status"]);
      return true;
    } catch {
      return false;
    }
  }
}
