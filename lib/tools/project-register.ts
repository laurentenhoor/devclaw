/**
 * project_register — Register a new project with DevClaw.
 *
 * Atomically: validates repo, detects GitHub/GitLab provider, creates all 8 state labels (idempotent),
 * adds project entry to projects.json, and logs the event.
 *
 * Replaces the manual steps of running glab/gh label create + editing projects.json.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../types.js";
import fs from "node:fs/promises";
import path from "node:path";
import { readProjects, writeProjects, emptyWorkerState } from "../projects.js";
import { resolveRepoPath } from "../projects.js";
import { createProvider } from "../providers/index.js";
import { log as auditLog } from "../audit.js";
import { DEV_TIERS, QA_TIERS } from "../tiers.js";
import { DEFAULT_DEV_INSTRUCTIONS, DEFAULT_QA_INSTRUCTIONS } from "../templates.js";
import { detectContext, generateGuardrails } from "../context-guard.js";

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

export function createProjectRegisterTool(api: OpenClawPluginApi) {
  return (ctx: ToolContext) => ({
    name: "project_register",
    label: "Project Register",
    description: `Register a new project with DevClaw. ONLY works in the Telegram/WhatsApp group you're registering. Creates state labels, adds to projects.json, auto-populates group ID. One-time setup per project.`,
    parameters: {
      type: "object",
      required: ["name", "repo", "baseBranch"],
      properties: {
        projectGroupId: {
          type: "string",
          description: "Telegram/WhatsApp group ID (optional - auto-detected from current group if omitted)",
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
      const groupName = (params.groupName as string) ?? `Project: ${name}`;
      const baseBranch = params.baseBranch as string;
      const deployBranch = (params.deployBranch as string) ?? baseBranch;
      const deployUrl = (params.deployUrl as string) ?? "";
      const roleExecution = (params.roleExecution as "parallel" | "sequential") ?? "parallel";
      const workspaceDir = ctx.workspaceDir;

      if (!workspaceDir) {
        throw new Error("No workspace directory available in tool context");
      }

      // --- Context detection ---
      const devClawAgentIds =
        ((api.pluginConfig as Record<string, unknown>)?.devClawAgentIds as
          | string[]
          | undefined) ?? [];
      const context = await detectContext(ctx, devClawAgentIds);

      // ONLY allow registration from group context
      // Design principle: One Group = One Project = One Team
      // This enforces project isolation and prevents accidental cross-registration.
      // You must be IN the group to register it, making the binding explicit and intentional.
      if (context.type !== "group") {
        return jsonResult({
          success: false,
          error: "Project registration can only be done from the Telegram/WhatsApp group you're registering.",
          recommendation:
            context.type === "via-agent"
              ? "If you're setting up DevClaw for the first time, use onboard. Then go to the project's Telegram/WhatsApp group to register it."
              : "Please go to the Telegram/WhatsApp group you want to register and call project_register from there.",
          contextGuidance: generateGuardrails(context),
        });
      }

      // Auto-populate projectGroupId if not provided (use current group)
      const actualGroupId = groupId || ctx.sessionKey;
      if (!actualGroupId) {
        throw new Error("Could not determine group ID from context. Please provide projectGroupId explicitly.");
      }

      // Provide helpful note if project is already registered
      const contextInfo = context.projectName
        ? `Note: This group is already registered as "${context.projectName}". You may be re-registering it.`
        : `Registering project for this ${context.channel} group (ID: ${actualGroupId.substring(0, 20)}...).`;

      // 1. Check project not already registered (allow re-register if incomplete)
      const data = await readProjects(workspaceDir);
      const existing = data.projects[actualGroupId];
      if (existing && existing.dev?.sessions && Object.keys(existing.dev.sessions).length > 0) {
        throw new Error(
          `Project already registered for this group: "${existing.name}". Remove the existing entry first or use a different group.`,
        );
      }

      // 2. Resolve repo path
      const repoPath = resolveRepoPath(repo);

      // 3. Create provider and verify it works
      const { provider, type: providerType } = createProvider({ repo });

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
      data.projects[actualGroupId] = {
        name,
        repo,
        groupName,
        deployUrl,
        baseBranch,
        deployBranch,
        channel: context.channel,
        roleExecution,
        dev: emptyWorkerState([...DEV_TIERS]),
        qa: emptyWorkerState([...QA_TIERS]),
      };

      await writeProjects(workspaceDir, data);

      // 6. Scaffold role files
      const rolesCreated = await scaffoldRoleFiles(workspaceDir, name);

      // 7. Audit log
      await auditLog(workspaceDir, "project_register", {
        project: name,
        groupId: actualGroupId,
        repo,
        baseBranch,
        deployBranch,
        deployUrl: deployUrl || null,
      });

      // 8. Return announcement
      const rolesNote = rolesCreated ? " Role files scaffolded." : "";
      const announcement = `📋 Project "${name}" registered for group ${groupName}. Labels created.${rolesNote} Ready for tasks.`;

      return jsonResult({
        success: true,
        project: name,
        groupId: actualGroupId,
        repo,
        baseBranch,
        deployBranch,
        labelsCreated: 8,
        rolesScaffolded: rolesCreated,
        announcement,
        ...(contextInfo && { contextInfo }),
        contextGuidance: generateGuardrails(context),
      });
    },
  });
}
