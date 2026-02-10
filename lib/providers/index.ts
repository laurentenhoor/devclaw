/**
 * Provider factory — auto-detects GitHub vs GitLab from git remote.
 */
import { execFileSync } from "node:child_process";
import type { IssueProvider } from "./provider.js";
import { GitLabProvider } from "./gitlab.js";
import { GitHubProvider } from "./github.js";
import { resolveRepoPath } from "../projects.js";

export type ProviderOptions = {
  provider?: "gitlab" | "github";
  repo?: string;
  repoPath?: string;
};

export type ProviderWithType = {
  provider: IssueProvider;
  type: "github" | "gitlab";
};

function detectProvider(repoPath: string): "gitlab" | "github" {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd: repoPath, timeout: 5_000 }).toString().trim();
    return url.includes("github.com") ? "github" : "gitlab";
  } catch {
    return "gitlab";
  }
}

export function createProvider(opts: ProviderOptions): ProviderWithType {
  const repoPath = opts.repoPath ?? (opts.repo ? resolveRepoPath(opts.repo) : null);
  if (!repoPath) throw new Error("Either repoPath or repo must be provided");
  const type = opts.provider ?? detectProvider(repoPath);
  const provider = type === "github" ? new GitHubProvider({ repoPath }) : new GitLabProvider({ repoPath });
  return { provider, type };
}
