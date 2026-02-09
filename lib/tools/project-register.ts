/**
 * project_register — Register a new project with DevClaw.
 *
 * Atomically: validates repo, detects GitHub/GitLab provider, creates all 8 state labels (idempotent),
 * adds project entry to projects.json, and logs the event.
 *
 * Replaces the manual steps of running glab/gh label create + editing projects.json.
 */
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk";
import fs from "node:fs/promises";
import path from "node:path";
import { readProjects, writeProjects, emptyWorkerState } from "../projects.js";
import { resolveRepoPath } from "../gitlab.js";
import { createProvider } from "../providers/index.js";
import { log as auditLog } from "../audit.js";

/**
 * Ensure default role files exist, then copy them into the project's role directory.
 * Returns true if files were created, false if they already existed.
 */
async function scaffoldRoleFiles(workspaceDir: string, projectName: string): Promise<boolean> {
  const defaultDir = path.join(workspaceDir, "roles", "default");
  const projectDir = path.join(workspaceDir, "roles", projectName);

  // Ensure default role files exist
  await fs.mkdir(defaultDir, { recursive: true });

  const defaultDev = path.join(defaultDir, "dev.md");
  const defaultQa = path.join(defaultDir, "qa.md");

  try {
    await fs.access(defaultDev);
  } catch {
    await fs.writeFile(defaultDev, DEFAULT_DEV_INSTRUCTIONS, "utf-8");
  }

  try {
    await fs.access(defaultQa);
  } catch {
    await fs.writeFile(defaultQa, DEFAULT_QA_INSTRUCTIONS, "utf-8");
  }

  // Create project-specific role files (copy from default if not exist)
  await fs.mkdir(projectDir, { recursive: true });

  const projectDev = path.join(projectDir, "dev.md");
  const projectQa = path.join(projectDir, "qa.md");
  let created = false;

  try {
    await fs.access(projectDev);
  } catch {
    await fs.copyFile(defaultDev, projectDev);
    created = true;
  }

  try {
    await fs.access(projectQa);
  } catch {
    await fs.copyFile(defaultQa, projectQa);
    created = true;
  }

  return created;
}

const DEFAULT_DEV_INSTRUCTIONS = `# DEV Worker Instructions

- Work in a git worktree (never switch branches in the main repo)
- Run tests before completing
- Create an MR/PR to the base branch and merge it
- Clean up the worktree after merging
- When done, call task_complete with role "dev", result "done", and a brief summary
- If you discover unrelated bugs, call task_create to file them
- Do NOT call task_pickup, queue_status, session_health, or project_register
`;

const DEFAULT_QA_INSTRUCTIONS = `# QA Worker Instructions

- Pull latest from the base branch
- Run tests and linting
- Verify the changes address the issue requirements
- Check for regressions in related functionality
- When done, call task_complete with role "qa" and one of:
  - result "pass" if everything looks good
  - result "fail" with specific issues if problems found
  - result "refine" if you need human input to decide
- If you discover unrelated bugs, call task_create to file them
- Do NOT call task_pickup, queue_status, session_health, or project_register
`;

export function createProjectRegisterTool(api: OpenClawPluginApi) {
  return (ctx: OpenClawPluginToolContext) => ({
    name: "project_register",
    description: `Register a new project with DevClaw. Creates all required state labels (idempotent) and adds the project to projects.json. One-time setup per project. Auto-detects GitHub/GitLab from git remote.`,
    parameters: {
      type: "object",
      required: ["projectGroupId", "name", "repo", "groupName", "baseBranch"],
      properties: {
        projectGroupId: {
          type: "string",
          description: "Telegram group ID (will be the key in projects.json)",
        },
        name: {
          type: "string",
          description: "Short project name (e.g. 'my-webapp')",
        },
        repo: {
          type: "string",
          description: "Path to git repo (e.g. '~/git/my-project')",
        },
        groupName: {
          type: "string",
          description: "Telegram group display name (e.g. 'Dev - My Project')",
        },
        baseBranch: {
          type: "string",
          description: "Base branch for development (e.g. 'development', 'main')",
        },
        deployBranch: {
          type: "string",
          description: "Branch that triggers deployment. Defaults to baseBranch.",
        },
        deployUrl: {
          type: "string",
          description: "Deployment URL for the project",
        },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const groupId = params.projectGroupId as string;
      const name = params.name as string;
      const repo = params.repo as string;
      const groupName = params.groupName as string;
      const baseBranch = params.baseBranch as string;
      const deployBranch = (params.deployBranch as string) ?? baseBranch;
      const deployUrl = (params.deployUrl as string) ?? "";
      const workspaceDir = ctx.workspaceDir;

      if (!workspaceDir) {
        throw new Error("No workspace directory available in tool context");
      }

      // 1. Check project not already registered (allow re-register if incomplete)
      const data = await readProjects(workspaceDir);
      const existing = data.projects[groupId];
      if (existing && existing.dev?.sessions && Object.keys(existing.dev.sessions).length > 0) {
        throw new Error(
          `Project already registered for groupId ${groupId}: "${existing.name}". Use a different group ID or remove the existing entry first.`,
        );
      }

      // 2. Resolve repo path
      const repoPath = resolveRepoPath(repo);

      // 3. Create provider and verify it works
      const glabPath = (api.pluginConfig as Record<string, unknown>)?.glabPath as string | undefined;
      const ghPath = (api.pluginConfig as Record<string, unknown>)?.ghPath as string | undefined;
      const { provider, type: providerType } = createProvider({ glabPath, ghPath, repoPath });

      const healthy = await provider.healthCheck();
      if (!healthy) {
        const cliName = providerType === "github" ? "gh" : "glab";
        const cliInstallUrl = providerType === "github" 
          ? "https://cli.github.com" 
          : "https://gitlab.com/gitlab-org/cli";
        throw new Error(
          `${providerType.toUpperCase()} health check failed for ${repoPath}. ` +
          `Detected provider: ${providerType}. ` +
          `Ensure '${cliName}' CLI is installed, authenticated (${cliName} auth status), ` +
          `and the repo has a ${providerType.toUpperCase()} remote. ` +
          `Install ${cliName} from: ${cliInstallUrl}`
        );
      }

      // 4. Create all 8 state labels (idempotent)
      await provider.ensureAllStateLabels();

      // 5. Add project to projects.json
      data.projects[groupId] = {
        name,
        repo,
        groupName,
        deployUrl,
        baseBranch,
        deployBranch,
        autoChain: false,
        dev: emptyWorkerState(["haiku", "sonnet", "opus"]),
        qa: emptyWorkerState(["grok"]),
      };

      await writeProjects(workspaceDir, data);

      // 6. Scaffold role files
      const rolesCreated = await scaffoldRoleFiles(workspaceDir, name);

      // 7. Audit log
      await auditLog(workspaceDir, "project_register", {
        project: name,
        groupId,
        repo,
        baseBranch,
        deployBranch,
        deployUrl: deployUrl || null,
      });

      // 8. Return announcement
      const rolesNote = rolesCreated ? " Role files scaffolded." : "";
      const announcement = `📋 Project "${name}" registered for group ${groupName}. Labels created.${rolesNote} Ready for tasks.`;

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            project: name,
            groupId,
            repo,
            baseBranch,
            deployBranch,
            labelsCreated: 8,
            rolesScaffolded: rolesCreated,
            announcement,
          }, null, 2),
        }],
      };
    },
  });
}
