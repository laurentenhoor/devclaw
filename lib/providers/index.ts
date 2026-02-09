/**
 * Provider factory — creates the appropriate IssueProvider for a repository.
 *
 * Auto-detects provider from git remote URL:
 *   - github.com → GitHubProvider (gh CLI)
 *   - Everything else → GitLabProvider (glab CLI)
 *
 * Can be overridden with explicit `provider` option.
 */
import { execFileSync } from "node:child_process";
import type { IssueProvider } from "../issue-provider.js";
import { GitLabProvider } from "./gitlab.js";
import { GitHubProvider } from "./github.js";

export type ProviderOptions = {
  provider?: "gitlab" | "github";
  glabPath?: string;
  ghPath?: string;
  repoPath: string;
};

function detectProvider(repoPath: string): "gitlab" | "github" {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: repoPath,
      timeout: 5_000,
    }).toString().trim();

    if (url.includes("github.com")) return "github";
    return "gitlab";
  } catch {
    return "gitlab";
  }
}

export type ProviderWithType = {
  provider: IssueProvider;
  type: "github" | "gitlab";
};

export function createProvider(opts: ProviderOptions): ProviderWithType {
  const type = opts.provider ?? detectProvider(opts.repoPath);

  if (type === "github") {
    return {
      provider: new GitHubProvider({ ghPath: opts.ghPath, repoPath: opts.repoPath }),
      type: "github",
    };
  }
  return {
    provider: new GitLabProvider({ glabPath: opts.glabPath, repoPath: opts.repoPath }),
    type: "gitlab",
  };
}
