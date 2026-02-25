/**
 * attachment-hook.ts — Register message_received hook for attachment capture.
 *
 * Channel-agnostic: works with any OpenClaw channel (Telegram, Discord,
 * WhatsApp, Signal, Slack, etc.) since all channels normalize media into
 * MediaPath/MediaPaths in the message metadata.
 *
 * Listens for incoming messages with media and issue references (#N).
 * When both are present, reads the local file and associates it with the issue.
 */
import { homedir } from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginContext } from "../context.js";
import {
  extractMediaAttachments,
  extractIssueReferences,
  processAttachmentMessage,
} from "./attachments.js";
import { readProjects, type Project } from "../projects/index.js";
import { createProvider } from "../providers/index.js";
import { log as auditLog } from "../audit.js";

/**
 * Resolve which project a conversation maps to.
 * Looks up the conversationId in registered projects' channels.
 */
async function resolveProjectFromChannel(
  workspaceDir: string,
  conversationId: string,
): Promise<Project | null> {
  try {
    const data = await readProjects(workspaceDir);
    const projects = data.projects ?? {};
    for (const project of Object.values(projects)) {
      const channels = (project as Project).channels ?? [];
      for (const ch of channels) {
        if (String(ch.channelId) === String(conversationId)) {
          return project as Project;
        }
      }
      // Legacy: check top-level channelId
      const legacy = project as Project & { channelId?: string };
      if (legacy.channelId && String(legacy.channelId) === String(conversationId)) {
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
  const devclaw = agents?.list?.find((a) => a.id === "devclaw");
  if (devclaw?.workspace) return devclaw.workspace;
  return path.join(homedir(), ".openclaw", "workspace-devclaw");
}

/**
 * Register the message_received hook for attachment handling.
 *
 * Channel-agnostic: OpenClaw downloads media from all channels and stores
 * it locally, exposing MediaPath/MediaPaths in the message metadata.
 */
export function registerAttachmentHook(api: OpenClawPluginApi, ctx: PluginContext): void {
  api.on("message_received", async (event, eventCtx) => {
    const metadata = event.metadata;
    if (!metadata || typeof metadata !== "object") return;

    // Check for media in the message (channel-agnostic)
    const attachments = extractMediaAttachments(metadata as Record<string, unknown>);
    if (attachments.length === 0) return;

    // Check for issue references in the message text
    const issueIds = extractIssueReferences(event.content ?? "");
    if (issueIds.length === 0) return;

    // Resolve workspace directory
    const workspaceDir = resolveWorkspaceDir(ctx.config as unknown as Record<string, unknown>);
    if (!workspaceDir) return;

    const conversationId = eventCtx.conversationId;
    if (!conversationId) return;

    const project = await resolveProjectFromChannel(workspaceDir, conversationId);
    if (!project) return;

    // Process each referenced issue
    for (const issueId of issueIds) {
      try {
        const { provider } = await createProvider({ repo: project.repo, provider: project.provider, runCommand: ctx.runCommand });

        await processAttachmentMessage({
          workspaceDir,
          projectSlug: project.slug,
          issueId,
          provider,
          uploader: event.from ?? "unknown",
          mediaAttachments: attachments,
        });

        ctx.logger.info(
          `Attachment hook: ${attachments.length} file(s) attached to #${issueId} in "${project.name}" via ${eventCtx.channelId}`,
        );
      } catch (err) {
        ctx.logger.warn(
          `Attachment hook: failed for #${issueId} in "${project.name}": ${(err as Error).message}`,
        );
        await auditLog(workspaceDir, "attachment_hook_error", {
          project: project.name,
          issueId,
          channel: eventCtx.channelId,
          error: (err as Error).message ?? String(err),
        }).catch(() => {});
      }
    }
  });
}
