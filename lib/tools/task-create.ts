/**
 * task_create — Create a new task (issue) in the project's issue tracker.
 *
 * Atomically: creates an issue with the specified title, description, and label.
 * Returns the created issue for immediate pickup if desired.
 *
 * Use this when:
 * - You want to create work items from chat
 * - A sub-agent finds a bug and needs to file a follow-up issue
 * - Breaking down an epic into smaller tasks
 */
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk";
import { readProjects, resolveRepoPath } from "../projects.js";
import { createProvider } from "../providers/index.js";
import { log as auditLog } from "../audit.js";
import type { StateLabel } from "../issue-provider.js";

const STATE_LABELS: StateLabel[] = [
  "Planning",
  "To Do",
  "Doing",
  "To Test",
  "Testing",
  "Done",
  "To Improve",
  "Refining",
];

export function createTaskCreateTool(api: OpenClawPluginApi) {
  return (ctx: OpenClawPluginToolContext) => ({
    name: "task_create",
    description: `Create a new task (issue) in the project's issue tracker. Use this to file bugs, features, or tasks from chat.

Examples:
- Simple: { title: "Fix login bug" }
- With body: { title: "Add dark mode", description: "## Why\nUsers want dark mode...\n\n## Acceptance Criteria\n- [ ] Toggle in settings" }
- Ready for dev: { title: "Implement auth", description: "...", label: "To Do", pickup: true }

The issue is created with a state label (defaults to "Planning"). Returns the created issue for immediate pickup.`,
    parameters: {
      type: "object",
      required: ["projectGroupId", "title"],
      properties: {
        projectGroupId: {
          type: "string",
          description: "Telegram group ID for the project",
        },
        title: {
          type: "string",
          description: "Short, descriptive issue title (e.g., 'Fix login timeout bug')",
        },
        description: {
          type: "string",
          description: "Full issue body in markdown. Use for detailed context, acceptance criteria, reproduction steps, links. Supports GitHub-flavored markdown.",
        },
        label: {
          type: "string",
          description: `State label for the issue. One of: ${STATE_LABELS.join(", ")}. Defaults to "Planning".`,
          enum: STATE_LABELS,
        },
        assignees: {
          type: "array",
          items: { type: "string" },
          description: "GitHub/GitLab usernames to assign (optional)",
        },
        pickup: {
          type: "boolean",
          description: "If true, immediately pick up this issue for DEV after creation. Defaults to false.",
        },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const groupId = params.projectGroupId as string;
      const title = params.title as string;
      const description = (params.description as string) ?? "";
      const label = (params.label as StateLabel) ?? "Planning";
      const assignees = (params.assignees as string[] | undefined) ?? [];
      const pickup = (params.pickup as boolean) ?? false;
      const workspaceDir = ctx.workspaceDir;

      if (!workspaceDir) {
        throw new Error("No workspace directory available in tool context");
      }

      // 1. Resolve project
      const data = await readProjects(workspaceDir);
      const project = data.projects[groupId];
      if (!project) {
        throw new Error(`Project not found for groupId ${groupId}. Run project_register first.`);
      }

      // 2. Create provider
      const repoPath = resolveRepoPath(project.repo);
      const config = api.pluginConfig as Record<string, unknown> | undefined;
      const { provider, type: providerType } = createProvider({
        glabPath: config?.glabPath as string | undefined,
        ghPath: config?.ghPath as string | undefined,
        repoPath,
      });

      // 3. Create the issue
      const issue = await provider.createIssue(title, description, label, assignees);

      // 4. Audit log
      await auditLog(workspaceDir, "task_create", {
        project: project.name,
        groupId,
        issueId: issue.iid,
        title,
        label,
        provider: providerType,
        pickup,
      });

      // 5. Build response
      const hasBody = description && description.trim().length > 0;
      const result = {
        success: true,
        issue: {
          id: issue.iid,
          title: issue.title,
          body: hasBody ? description : null,
          url: issue.web_url,
          label,
        },
        project: project.name,
        provider: providerType,
        pickup,
        announcement: pickup
          ? `📋 Created #${issue.iid}: "${title}" (${label}).${hasBody ? " With detailed description." : ""} Picking up for DEV...`
          : `📋 Created #${issue.iid}: "${title}" (${label}).${hasBody ? " With detailed description." : ""} Ready for pickup when needed.`,
      };

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    },
  });
}
