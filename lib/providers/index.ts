/**
 * Provider factory — auto-detects GitHub vs GitLab from git remote.
 */
import type { IssueProvider } from "./provider.js";
import { GitLabProvider } from "./gitlab.js";
import { GitHubProvider } from "./github.js";
import { resolveRepoPath } from "../projects.js";
import { runCommand } from "../run-command.js";

export type ProviderOptions = {
  provider?: "gitlab" | "github";
  repo?: string;
  repoPath?: string;
};

export type ProviderWithType = {
  provider: IssueProvider;
  type: "github" | "gitlab";
};

async function detectProvider(repoPath: string): Promise<"gitlab" | "github"> {
  try {
    const result = await runCommand(["git", "remote", "get-url", "origin"], { timeoutMs: 5_000, cwd: repoPath });
    return result.stdout.trim().includes("github.com") ? "github" : "gitlab";
  } catch {
    return "gitlab";
  }
}

export async function createProvider(opts: ProviderOptions): Promise<ProviderWithType> {
  const repoPath = opts.repoPath ?? (opts.repo ? resolveRepoPath(opts.repo) : null);
  if (!repoPath) throw new Error("Either repoPath or repo must be provided");
  const type = opts.provider ?? await detectProvider(repoPath);
  const provider = type === "github" ? new GitHubProvider({ repoPath }) : new GitLabProvider({ repoPath });
  return { provider, type };
}
