/**
 * task_comment — Add review comments or notes to an issue.
 *
 * Use cases:
 * - QA worker adds review feedback without blocking pass/fail
 * - DEV worker posts implementation notes
 * - Orchestrator adds summary comments
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../types.js";
import { log as auditLog } from "../audit.js";
import { requireWorkspaceDir, resolveProject, resolveProvider } from "../tool-helpers.js";

/** Valid author roles for attribution */
const AUTHOR_ROLES = ["dev", "qa", "orchestrator"] as const;
type AuthorRole = (typeof AUTHOR_ROLES)[number];

export function createTaskCommentTool(api: OpenClawPluginApi) {
  return (ctx: ToolContext) => ({
    name: "task_comment",
    label: "Task Comment",
    description: `Add a comment to an issue. Use this for review feedback, implementation notes, or any discussion that doesn't require a state change.

Use cases:
- QA adds review feedback without blocking pass/fail
- DEV posts implementation notes or progress updates
- Orchestrator adds summary comments
- Cross-referencing related issues or PRs

Examples:
- Simple: { projectGroupId: "-123456789", issueId: 42, body: "Found an edge case with null inputs" }
- With role: { projectGroupId: "-123456789", issueId: 42, body: "LGTM!", authorRole: "qa" }
- Detailed: { projectGroupId: "-123456789", issueId: 42, body: "## Notes\\n\\n- Tested on staging\\n- All checks passing", authorRole: "dev" }`,
    parameters: {
      type: "object",
      required: ["projectGroupId", "issueId", "body"],
      properties: {
        projectGroupId: {
          type: "string",
          description: "Telegram/WhatsApp group ID (key in projects.json)",
        },
        issueId: {
          type: "number",
          description: "Issue ID to comment on",
        },
        body: {
          type: "string",
          description: "Comment body in markdown. Supports GitHub-flavored markdown.",
        },
        authorRole: {
          type: "string",
          enum: AUTHOR_ROLES,
          description: `Optional role attribution for the comment. One of: ${AUTHOR_ROLES.join(", ")}`,
        },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const groupId = params.projectGroupId as string;
      const issueId = params.issueId as number;
      const body = params.body as string;
      const authorRole = (params.authorRole as AuthorRole) ?? undefined;
      const workspaceDir = requireWorkspaceDir(ctx);

      if (!body || body.trim().length === 0) {
        throw new Error("Comment body cannot be empty.");
      }

      const { project } = await resolveProject(workspaceDir, groupId);
      const { provider, type: providerType } = resolveProvider(project);

      const issue = await provider.getIssue(issueId);

      const commentBody = authorRole
        ? `${ROLE_EMOJI[authorRole]} **${authorRole.toUpperCase()}**: ${body}`
        : body;

      await provider.addComment(issueId, commentBody);

      await auditLog(workspaceDir, "task_comment", {
        project: project.name, groupId, issueId,
        authorRole: authorRole ?? null,
        bodyPreview: body.slice(0, 100) + (body.length > 100 ? "..." : ""),
        provider: providerType,
      });

      return jsonResult({
        success: true, issueId, issueTitle: issue.title, issueUrl: issue.web_url,
        commentAdded: true, authorRole: authorRole ?? null, bodyLength: body.length,
        project: project.name, provider: providerType,
        announcement: `💬 Comment added to #${issueId}${authorRole ? ` by ${authorRole.toUpperCase()}` : ""}`,
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

const ROLE_EMOJI: Record<AuthorRole, string> = {
  dev: "👨‍💻",
  qa: "🔍",
  orchestrator: "🎛️",
};
