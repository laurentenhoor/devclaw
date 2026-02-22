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
import { readProjects, writeProjects, emptyRoleWorkerState } from "../projects.js";
import { resolveRepoPath } from "../projects.js";
import { runCommand } from "../run-command.js";
import { createProvider } from "../providers/index.js";
import { log as auditLog } from "../audit.js";
import { getAllRoleIds, getLevelsForRole } from "../roles/index.js";
import { ExecutionMode, getRoleLabels } from "../workflow.js";
import { loadConfig } from "../config/index.js";
import { DATA_DIR } from "../setup/migrate-layout.js";

/**
 * Scaffold project directory with prompts/ folder and a README explaining overrides.
 * Returns true if files were created, false if they already existed.
 */
async function scaffoldPromptFiles(workspaceDir: string, projectName: string): Promise<boolean> {
  const projectDir = path.join(workspaceDir, DATA_DIR, "projects", projectName);
  const promptsDir = path.join(projectDir, "prompts");
  await fs.mkdir(promptsDir, { recursive: true });

  const readmePath = path.join(projectDir, "README.md");
  try {
    await fs.access(readmePath);
    return false;
  } catch {
    const roles = getAllRoleIds().join(", ");
    await fs.writeFile(readmePath, `# Project Overrides

This directory holds project-specific configuration that overrides the workspace defaults.

## Prompt Overrides

To override default worker instructions, create \`prompts/<role>.md\`:

Available roles: ${roles}

Example: \`prompts/developer.md\` overrides the default developer instructions for this project only.
Files here take priority over the workspace defaults in \`devclaw/prompts/\`.

## Workflow Overrides

To override the default workflow configuration, create \`workflow.yaml\` in this directory.

Only include the keys you want to override — everything else inherits from the workspace-level \`devclaw/workflow.yaml\`. The three-layer system is:

1. **Built-in defaults** (code)
2. **Workspace** — \`devclaw/workflow.yaml\`
3. **Project** — \`devclaw/projects/${projectName}/workflow.yaml\` (this directory)

Example — use a different review policy for this project:

\`\`\`yaml
workflow:
  reviewPolicy: agent
\`\`\`

Example — override model for senior developer:

\`\`\`yaml
roles:
  developer:
    models:
      senior: claude-sonnet-4-5-20250514
\`\`\`

Call \`workflow_guide\` for the full config reference.
`, "utf-8");
    return true;
  }
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
        const result = await runCommand(["git", "remote", "get-url", "origin"], {
          timeoutMs: 5_000,
          cwd: repoPath,
        });
        repoRemote = result.stdout.trim() || undefined;
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
        // Create new project - get maxWorkers from resolved config (already loaded above)
        const workers: Record<string, import("../projects.js").RoleWorkerState> = {};
        for (const role of getAllRoleIds()) {
          const maxWorkers = resolvedConfig.roles[role]?.maxWorkers ?? 1;
          workers[role] = emptyRoleWorkerState(maxWorkers);
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

      // Active workflow info for the orchestrator to mention
      const activeWorkflow = {
        reviewPolicy: resolvedConfig.workflow.reviewPolicy ?? "human",
        testPhase: Object.values(resolvedConfig.workflow.states).some(
          (s) => s.role === "tester" && (s.type === "queue" || s.type === "active"),
        ),
        hint: "The user can change the review policy or enable the test phase — call workflow_guide for the full reference.",
      };

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
        activeWorkflow,
        announcement,
      });
    },
  });
}
