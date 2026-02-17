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
import { ExecutionMode, getRoleLabels } from "../workflow.js";
import { loadConfig } from "../config/index.js";
import { DEFAULT_ROLE_INSTRUCTIONS } from "../templates.js";
import { DATA_DIR } from "../setup/migrate-layout.js";

/**
 * Scaffold project-specific prompt files for all registered roles.
 * Returns true if files were created, false if they already existed.
 */
async function scaffoldPromptFiles(workspaceDir: string, projectName: string): Promise<boolean> {
  const promptsDir = path.join(workspaceDir, DATA_DIR, "projects", projectName, "prompts");
  await fs.mkdir(promptsDir, { recursive: true });

  let created = false;
  for (const role of getAllRoleIds()) {
    const filePath = path.join(promptsDir, `${role}.md`);
    try {
      await fs.access(filePath);
    } catch {
      const content = DEFAULT_ROLE_INSTRUCTIONS[role] ?? `# ${role.toUpperCase()} Worker Instructions\n\nAdd role-specific instructions here.\n`;
      await fs.writeFile(filePath, content, "utf-8");
      created = true;
    }
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
          enum: Object.values(ExecutionMode),
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
      const roleExecution = (params.roleExecution as ExecutionMode) ?? ExecutionMode.PARALLEL;
      const workspaceDir = ctx.workspaceDir;

      if (!workspaceDir) {
        throw new Error("No workspace directory available in tool context");
      }

      // Generate slug from project name
      const slug = name.toLowerCase().replace(/\s+/g, "-");

      // 1. Check project exists or can be created
      const data = await readProjects(workspaceDir);
      const existing = data.projects[slug];
      
      // If project exists, check if this groupId is already registered
      if (existing) {
        const channelExists = existing.channels.some(ch => ch.groupId === groupId);
        if (channelExists) {
          throw new Error(
            `Group ${groupId} is already registered for project "${name}". Each group can only register once per project.`,
          );
        }
        // Adding a new channel to an existing project
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

      // 4b. Create role:level + step routing labels (e.g. developer:junior, review:human, test:skip)
      const resolvedConfig = await loadConfig(workspaceDir, name);
      const roleLabels = getRoleLabels(resolvedConfig.roles);
      for (const { name: labelName, color } of roleLabels) {
        await provider.ensureLabel(labelName, color);
      }

      // 5. Auto-detect repoRemote from git
      let repoRemote: string | undefined;
      try {
        const { execSync } = require("node:child_process");
        repoRemote = execSync("git remote get-url origin", {
          cwd: repoPath,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "ignore"],
        }).trim();
      } catch {
        repoRemote = undefined;
      }

      // 6. Add or update project in projects.json
      if (existing) {
        // Add channel to existing project
        const newChannel: import("../projects.js").Channel = {
          groupId,
          channel: channel as "telegram" | "whatsapp" | "discord" | "slack",
          name: `channel-${existing.channels.length + 1}`,
          events: ["*"],
        };
        existing.channels.push(newChannel);
        if (repoRemote && !existing.repoRemote) {
          existing.repoRemote = repoRemote;
        }
      } else {
        // Create new project
        const workers: Record<string, import("../projects.js").WorkerState> = {};
        for (const role of getAllRoleIds()) {
          workers[role] = emptyWorkerState([...getLevelsForRole(role)]);
        }

        const newChannel: import("../projects.js").Channel = {
          groupId,
          channel: channel as "telegram" | "whatsapp" | "discord" | "slack",
          name: "primary",
          events: ["*"],
        };

        data.projects[slug] = {
          slug,
          name,
          repo,
          repoRemote,
          groupName,
          deployUrl,
          baseBranch,
          deployBranch,
          channels: [newChannel],
          provider: providerType,
          roleExecution,
          workers,
        };
      }

      await writeProjects(workspaceDir, data);

      // 7. Scaffold prompt files
      const promptsCreated = await scaffoldPromptFiles(workspaceDir, name);

      // 8. Audit log
      await auditLog(workspaceDir, "project_register", {
        project: name,
        projectSlug: slug,
        groupId,
        repo,
        repoRemote: repoRemote || null,
        baseBranch,
        deployBranch,
        deployUrl: deployUrl || null,
        isNewProject: !existing,
      });

      // 9. Return announcement
      const promptsNote = promptsCreated ? " Prompt files scaffolded." : "";
      const action = existing ? `Channel added to existing project` : `Project "${name}" created`;
      const announcement = `${action}. Labels ensured.${promptsNote} Ready for tasks.`;

      return jsonResult({
        success: true,
        project: name,
        projectSlug: slug,
        groupId,
        repo,
        repoRemote: repoRemote || null,
        baseBranch,
        deployBranch,
        labelsCreated: 10,
        promptsScaffolded: promptsCreated,
        isNewProject: !existing,
        announcement,
      });
    },
  });
}
