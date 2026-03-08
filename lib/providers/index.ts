/**
 * Provider factory — auto-detects GitHub vs GitLab vs Gitea from git remote.
 */
import type { IssueProvider } from "./provider.js";
import type { RunCommand } from "../context.js";
import { GitLabProvider } from "./gitlab.js";
import { GitHubProvider } from "./github.js";
import { GiteaProvider } from "./gitea.js";
import { resolveRepoPath } from "../projects/index.js";

export type ProviderOptions = {
  provider?: "gitlab" | "github" | "gitea";
  repo?: string;
  repoPath?: string;
  runCommand: RunCommand;
};

export type ProviderWithType = {
  provider: IssueProvider;
  type: "github" | "gitlab" | "gitea";
};

async function detectProvider(
  repoPath: string,
  runCommand: RunCommand
): Promise<"gitlab" | "github" | "gitea"> {
  try {
    const result = await runCommand(
      ["git", "remote", "get-url", "origin"],
      { timeoutMs: 5_000, cwd: repoPath }
    );
    const url = result.stdout.trim().toLowerCase();

    if (url.includes("github.com")) return "github";
    if (url.includes("gitlab.com")) return "gitlab";

    // Check for Gitea: URL contains "gitea" or tea CLI recognizes this repo
    if (url.includes("gitea") || (await isGiteaRepo(repoPath, runCommand))) {
      return "gitea";
    }

    return "gitlab";
  } catch {
    return "gitlab";
  }
}

async function isGiteaRepo(
  repoPath: string,
  runCommand: RunCommand
): Promise<boolean> {
  try {
    // Try to get repo info via tea CLI - if it works, it's a Gitea repo
    await runCommand(["tea", "repo", "info"], { timeoutMs: 5_000, cwd: repoPath });
    return true;
  } catch {
    return false;
  }
}

export async function createProvider(opts: ProviderOptions): Promise<ProviderWithType> {
  const repoPath = opts.repoPath ?? (opts.repo ? resolveRepoPath(opts.repo) : null);
  if (!repoPath) throw new Error("Either repoPath or repo must be provided");
  const rc = opts.runCommand;
  const type = opts.provider ?? (await detectProvider(repoPath, rc));

  switch (type) {
    case "github":
      return { provider: new GitHubProvider({ repoPath, runCommand: rc }), type };
    case "gitea":
      return { provider: new GiteaProvider({ repoPath, runCommand: rc }), type };
    case "gitlab":
    default:
      return { provider: new GitLabProvider({ repoPath, runCommand: rc }), type };
  }
}
