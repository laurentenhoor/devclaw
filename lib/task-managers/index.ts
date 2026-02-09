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
import type { TaskManager } from "./task-manager.js";
import { GitLabProvider } from "./gitlab.js";
import { GitHubProvider } from "./github.js";
import { resolveRepoPath } from "../utils.js";

export type ProviderOptions = {
  provider?: "gitlab" | "github";
  repo?: string;
  repoPath?: string;
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
  provider: TaskManager;
  type: "github" | "gitlab";
};

export function createProvider(opts: ProviderOptions): ProviderWithType {
  const repoPath = opts.repoPath ?? (opts.repo ? resolveRepoPath(opts.repo) : null);
  if (!repoPath) {
    throw new Error("Either repoPath or repo must be provided to createProvider");
  }

  const type = opts.provider ?? detectProvider(repoPath);

  if (type === "github") {
    return {
      provider: new GitHubProvider({ repoPath }),
      type: "github",
    };
  }
  return {
    provider: new GitLabProvider({ repoPath }),
    type: "gitlab",
  };
}
