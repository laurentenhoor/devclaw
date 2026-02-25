/**
 * task_comment — Add review comments or notes to an issue.
 *
 * Use cases:
 * - Tester worker adds review feedback without blocking pass/fail
 * - Developer worker posts implementation notes
 * - Orchestrator adds summary comments
 */
import { jsonResult } from "openclaw/plugin-sdk";
import type { PluginContext } from "../../context.js";
import type { ToolContext } from "../../types.js";
import { log as auditLog } from "../../audit.js";
import { requireWorkspaceDir, resolveChannelId, resolveProject, resolveProvider, autoAssignOwnerLabel, applyNotifyLabel } from "../helpers.js";
import { getAllRoleIds, getFallbackEmoji } from "../../roles/index.js";

/** Valid author roles for attribution — all registry roles + orchestrator */
const AUTHOR_ROLES = [...getAllRoleIds(), "orchestrator"];
type AuthorRole = string;

export function createTaskCommentTool(ctx: PluginContext) {
  return (toolCtx: ToolContext) => ({
    name: "task_comment",
    label: "Task Comment",
    description: `Add a comment to an issue. Use this for review feedback, implementation notes, or any discussion that doesn't require a state change.

Use cases:
- Tester adds review feedback without blocking pass/fail
- Developer posts implementation notes or progress updates
- Orchestrator adds summary comments
- Cross-referencing related issues or PRs

Examples:
- Simple: { issueId: 42, body: "Found an edge case with null inputs" }
- With role: { issueId: 42, body: "LGTM!", authorRole: "tester" }
- Detailed: { issueId: 42, body: "## Notes\\n\\n- Tested on staging\\n- All checks passing", authorRole: "developer" }`,
    parameters: {
      type: "object",
      required: ["channelId", "issueId", "body"],
      properties: {
        channelId: {
          type: "string",
          description: "YOUR chat/group ID — the numeric ID of the chat you are in right now (e.g. '-1003844794417'). Do NOT guess; use the ID of the conversation this message came from.",
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
      const channelId = resolveChannelId(toolCtx, params.channelId as string | undefined);
      const issueId = params.issueId as number;
      const body = params.body as string;
      const authorRole = (params.authorRole as AuthorRole) ?? undefined;
      const workspaceDir = requireWorkspaceDir(toolCtx);

      if (!body || body.trim().length === 0) {
        throw new Error("Comment body cannot be empty.");
      }

      const { project } = await resolveProject(workspaceDir, channelId);
      const { provider, type: providerType } = await resolveProvider(project, ctx.runCommand);

      const issue = await provider.getIssue(issueId);

      const commentBody = authorRole
        ? `${getRoleEmoji(authorRole)} **${authorRole.toUpperCase()}**: ${body}`
        : body;

      const commentId = await provider.addComment(issueId, commentBody);

      // Mark as system-managed (best-effort).
      provider.reactToIssueComment(issueId, commentId, "eyes").catch(() => {});

      // Apply notify label for channel routing (best-effort).
      applyNotifyLabel(provider, issueId, project, channelId, issue.labels);

      // Auto-assign owner label to this instance (best-effort).
      autoAssignOwnerLabel(workspaceDir, provider, issueId, project).catch(() => {});

      await auditLog(workspaceDir, "task_comment", {
        project: project.name, issueId,
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

function getRoleEmoji(role: string): string {
  if (role === "orchestrator") return "🎛️";
  return getFallbackEmoji(role);
}
