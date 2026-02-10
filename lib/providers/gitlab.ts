/**
 * GitLabProvider — IssueProvider implementation using glab CLI.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  type IssueProvider,
  type Issue,
  type StateLabel,
  STATE_LABELS,
  LABEL_COLORS,
} from "./provider.js";

const execFileAsync = promisify(execFile);

export class GitLabProvider implements IssueProvider {
  private repoPath: string;
  constructor(opts: { repoPath: string }) { this.repoPath = opts.repoPath; }

  private async glab(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("glab", args, { cwd: this.repoPath, timeout: 30_000 });
    return stdout.trim();
  }

  async ensureLabel(name: string, color: string): Promise<void> {
    try { await this.glab(["label", "create", "--name", name, "--color", color]); }
    catch (err) { const msg = (err as Error).message ?? ""; if (!msg.includes("already exists") && !msg.includes("409")) throw err; }
  }

  async ensureAllStateLabels(): Promise<void> {
    for (const label of STATE_LABELS) await this.ensureLabel(label, LABEL_COLORS[label]);
  }

  async createIssue(title: string, description: string, label: StateLabel, assignees?: string[]): Promise<Issue> {
    const tempFile = join(tmpdir(), `devclaw-issue-${Date.now()}.md`);
    await writeFile(tempFile, description, "utf-8");
    try {
      const { exec } = await import("node:child_process");
      const execAsync = promisify(exec);
      let cmd = `glab issue create --title "${title.replace(/"/g, '\\"')}" --description "$(cat ${tempFile})" --label "${label}"`;
      if (assignees?.length) cmd += ` --assignee "${assignees.join(",")}"`;
      const { stdout } = await execAsync(cmd, { cwd: this.repoPath, timeout: 30_000 });
      // glab issue create returns the issue URL
      const match = stdout.trim().match(/\/issues\/(\d+)/);
      if (!match) throw new Error(`Failed to parse issue URL: ${stdout.trim()}`);
      return this.getIssue(parseInt(match[1], 10));
    } finally { try { await unlink(tempFile); } catch { /* ignore */ } }
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
    const tempFile = join(tmpdir(), `devclaw-comment-${Date.now()}.md`);
    await writeFile(tempFile, body, "utf-8");
    try {
      const { exec } = await import("node:child_process");
      const execAsync = promisify(exec);
      await execAsync(`glab issue note ${issueId} --message "$(cat ${tempFile})"`, { cwd: this.repoPath, timeout: 30_000 });
    } finally { try { await unlink(tempFile); } catch { /* ignore */ } }
  }

  async healthCheck(): Promise<boolean> {
    try { await this.glab(["auth", "status"]); return true; } catch { return false; }
  }
}
