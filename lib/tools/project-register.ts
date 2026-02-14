/**
 * project_register — Register a new project with DevClaw.
 *
 * Atomically: validates repo, detects GitHub/GitLab provider, creates all 8 state labels (idempotent),
 * adds project entry to projects.json, and logs the event.
 *
 * Replaces the manual steps of running glab/gh label create + editing projects.json.
 */
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../types.js";
import fs from "node:fs/promises";
import path from "node:path";
import { readProjects, writeProjects, emptyWorkerState } from "../projects.js";
import { resolveRepoPath } from "../projects.js";
import { createProvider } from "../providers/index.js";
import { log as auditLog } from "../audit.js";
import { getAllRoleIds, getLevelsForRole } from "../roles/index.js";
import { DEFAULT_DEV_INSTRUCTIONS, DEFAULT_QA_INSTRUCTIONS, DEFAULT_ARCHITECT_INSTRUCTIONS } from "../templates.js";

/**
 * Scaffold project-specific prompt files.
 * Returns true if files were created, false if they already existed.
 */
async function scaffoldPromptFiles(workspaceDir: string, projectName: string): Promise<boolean> {
  const projectDir = path.join(workspaceDir, "projects", "roles", projectName);
  await fs.mkdir(projectDir, { recursive: true });

  const projectDev = path.join(projectDir, "dev.md");
  const projectQa = path.join(projectDir, "qa.md");
  let created = false;

  try {
    await fs.access(projectDev);
  } catch {
    await fs.writeFile(projectDev, DEFAULT_DEV_INSTRUCTIONS, "utf-8");
    created = true;
  }

  try {
    await fs.access(projectQa);
  } catch {
    await fs.writeFile(projectQa, DEFAULT_QA_INSTRUCTIONS, "utf-8");
    created = true;
  }

  const projectArchitect = path.join(projectDir, "architect.md");
  try {
    await fs.access(projectArchitect);
  } catch {
    await fs.writeFile(projectArchitect, DEFAULT_ARCHITECT_INSTRUCTIONS, "utf-8");
    created = true;
  }

  return created;
}

export function createProjectRegisterTool() {
  return (ctx: ToolContext) => ({
    name: "project_register",
    label: "Project Register",
    description: `Register a new project with DevClaw. Creates state labels, adds to projects.json. One-time setup per project.`,
    parameters: {
      type: "object",
      required: ["projectGroupId", "name", "repo", "baseBranch"],
      properties: {
        projectGroupId: {
          type: "string",
          description: "Project group ID (e.g. Telegram/WhatsApp group ID)",
        },
        name: {
          type: "string",
          description: "Short project name (e.g. 'my-webapp')",
        },
        repo: {
          type: "string",
          description: "Path to git repo (e.g. '~/git/my-project')",
        },
        channel: {
          type: "string",
          description: "Channel type (e.g. 'telegram', 'whatsapp'). Defaults to 'telegram'.",
        },
        groupName: {
          type: "string",
          description: "Group display name (optional - defaults to 'Project: {name}')",
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
        roleExecution: {
          type: "string",
          enum: ["parallel", "sequential"],
          description: "Project-level role execution mode: parallel (DEV and QA can work simultaneously) or sequential (only one role active at a time). Defaults to parallel.",
        },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const groupId = params.projectGroupId as string;
      const name = params.name as string;
      const repo = params.repo as string;
      const channel = (params.channel as string) ?? "telegram";
      const groupName = (params.groupName as string) ?? `Project: ${name}`;
      const baseBranch = params.baseBranch as string;
      const deployBranch = (params.deployBranch as string) ?? baseBranch;
      const deployUrl = (params.deployUrl as string) ?? "";
      const roleExecution = (params.roleExecution as "parallel" | "sequential") ?? "parallel";
      const workspaceDir = ctx.workspaceDir;

      if (!workspaceDir) {
        throw new Error("No workspace directory available in tool context");
      }

      // 1. Check project not already registered (allow re-register if incomplete)
      const data = await readProjects(workspaceDir);
      const existing = data.projects[groupId];
      if (existing && existing.dev?.sessions && Object.keys(existing.dev.sessions).length > 0) {
        throw new Error(
          `Project already registered for this group: "${existing.name}". Remove the existing entry first or use a different group.`,
        );
      }

      // 2. Resolve repo path
      const repoPath = resolveRepoPath(repo);

      // 3. Create provider and verify it works
      const { provider, type: providerType } = await createProvider({ repo });

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

      // 4. Create all state labels (idempotent)
      await provider.ensureAllStateLabels();

      // 5. Add project to projects.json
      data.projects[groupId] = {
        name,
        repo,
        groupName,
        deployUrl,
        baseBranch,
        deployBranch,
        channel,
        roleExecution,
        dev: emptyWorkerState([...getLevelsForRole("dev")]),
        qa: emptyWorkerState([...getLevelsForRole("qa")]),
        architect: emptyWorkerState([...getLevelsForRole("architect")]),
      };

      await writeProjects(workspaceDir, data);

      // 6. Scaffold prompt files
      const promptsCreated = await scaffoldPromptFiles(workspaceDir, name);

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
      const promptsNote = promptsCreated ? " Prompt files scaffolded." : "";
      const announcement = `Project "${name}" registered for group ${groupName}. Labels created.${promptsNote} Ready for tasks.`;

      return jsonResult({
        success: true,
        project: name,
        groupId,
        repo,
        baseBranch,
        deployBranch,
        labelsCreated: 10,
        promptsScaffolded: promptsCreated,
        announcement,
      });
    },
  });
}
