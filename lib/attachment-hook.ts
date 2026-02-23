/**
 * attachment-hook.ts — Register message_received hook for Telegram attachment capture.
 *
 * Listens for incoming Telegram messages with media and issue references (#N).
 * When both are present, downloads the file and associates it with the issue.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  extractTelegramAttachments,
  extractIssueReferences,
  processAttachmentMessage,
} from "./attachments.js";
import { readProjects, type Project } from "./projects.js";
import { createProvider } from "./providers/index.js";
import { log as auditLog } from "./audit.js";

/**
 * Resolve which project a Telegram group maps to.
 * Looks up the conversationId (group/chat ID) in registered projects' channels.
 */
async function resolveProjectFromGroup(
  workspaceDir: string,
  conversationId: string,
): Promise<Project | null> {
  try {
    const data = await readProjects(workspaceDir);
    const projects = data.projects ?? {};
    for (const project of Object.values(projects)) {
      const channels = (project as Project).channels ?? [];
      for (const ch of channels) {
        if (String(ch.groupId) === String(conversationId)) {
          return project as Project;
        }
      }
      // Legacy: check top-level groupId
      const legacy = project as Project & { groupId?: string };
      if (legacy.groupId && String(legacy.groupId) === String(conversationId)) {
        return project as Project;
      }
    }
  } catch { /* no projects yet */ }
  return null;
}

/**
 * Resolve the workspace directory from OpenClaw config.
 * Checks agents.defaults.workspace, then falls back to ~/.openclaw/workspace-devclaw.
 */
function resolveWorkspaceDir(config: Record<string, unknown>): string | null {
  const agents = config.agents as { defaults?: { workspace?: string }; list?: Array<{ id: string; workspace?: string }> } | undefined;
  if (agents?.defaults?.workspace) return agents.defaults.workspace;
  // Check agent list for a devclaw agent
  const devclaw = agents?.list?.find((a) => a.id === "devclaw");
  if (devclaw?.workspace) return devclaw.workspace;
  // Fallback to standard path
  const { homedir } = require("node:os");
  const path = require("node:path");
  const fallback = path.join(homedir(), ".openclaw", "workspace-devclaw");
  return fallback;
}

/**
 * Register the message_received hook for Telegram attachment handling.
 */
export function registerAttachmentHook(api: OpenClawPluginApi): void {
  api.on("message_received", async (event, ctx) => {
    // Only process Telegram messages
    if (ctx.channelId !== "telegram") return;

    const metadata = event.metadata;
    if (!metadata || typeof metadata !== "object") return;

    // Check for attachments in the message
    const attachments = extractTelegramAttachments(metadata as Record<string, unknown>);
    if (attachments.length === 0) return;

    // Check for issue references in the message text
    const issueIds = extractIssueReferences(event.content ?? "");
    if (issueIds.length === 0) {
      // No explicit issue reference — check if this is a reply to an issue thread
      // (future enhancement: thread tracking)
      return;
    }

    // Resolve workspace directory from plugin config
    const workspaceDir = resolveWorkspaceDir(api.config as unknown as Record<string, unknown>);
    if (!workspaceDir) return;

    const conversationId = ctx.conversationId;
    if (!conversationId) return;

    const project = await resolveProjectFromGroup(workspaceDir, conversationId);
    if (!project) return;

    // Process each referenced issue
    const { type: providerType } = await createProvider({ repo: project.repo, provider: project.provider });

    for (const issueId of issueIds) {
      try {
        const { provider } = await createProvider({ repo: project.repo, provider: project.provider });

        await processAttachmentMessage({
          workspaceDir,
          projectSlug: project.slug,
          issueId,
          provider,
          providerType: providerType as "github" | "gitlab",
          repoPath: project.repo,
          uploader: event.from ?? "unknown",
          telegramAttachments: attachments,
        });

        api.logger.info(
          `Attachment hook: ${attachments.length} file(s) attached to #${issueId} in "${project.name}"`,
        );
      } catch (err) {
        api.logger.warn(
          `Attachment hook: failed for #${issueId} in "${project.name}": ${(err as Error).message}`,
        );
        await auditLog(workspaceDir, "attachment_hook_error", {
          project: project.name,
          issueId,
          error: (err as Error).message ?? String(err),
        }).catch(() => {});
      }
    }
  });
}
