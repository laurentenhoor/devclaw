/**
 * task_attach — Attach files to issues or list existing attachments.
 *
 * Use cases:
 * - List attachments on an issue (for architects/developers)
 * - Manually attach a local file to an issue
 * - View attachment metadata and local paths
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../types.js";
import { log as auditLog } from "../audit.js";
import { requireWorkspaceDir, resolveProject, resolveProvider } from "../tool-helpers.js";
import {
  listAttachments,
  saveAttachment,
  getAttachmentPath,
  formatAttachmentComment,
} from "../attachments.js";
import fs from "node:fs/promises";
import path from "node:path";

export function createTaskAttachTool(api: OpenClawPluginApi) {
  return (ctx: ToolContext) => ({
    name: "task_attach",
    label: "Task Attach",
    description: `Manage file attachments on issues. List existing attachments or add new ones from local files.

Use cases:
- List attachments: { projectSlug: "my-app", issueId: 42, action: "list" }
- Attach file: { projectSlug: "my-app", issueId: 42, action: "add", filePath: "/path/to/file.png" }
- Get attachment path: { projectSlug: "my-app", issueId: 42, action: "get", attachmentId: "abc-123" }`,
    parameters: {
      type: "object",
      required: ["projectSlug", "issueId"],
      properties: {
        projectSlug: {
          type: "string",
          description: "Project slug (e.g. 'my-webapp').",
        },
        issueId: {
          type: "number",
          description: "Issue ID",
        },
        action: {
          type: "string",
          enum: ["list", "add", "get"],
          description: "Action to perform. Defaults to 'list'.",
        },
        filePath: {
          type: "string",
          description: "Local file path to attach (required for 'add' action).",
        },
        attachmentId: {
          type: "string",
          description: "Attachment ID to retrieve (required for 'get' action).",
        },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const slug = params.projectSlug as string;
      const issueId = params.issueId as number;
      const action = (params.action as string) ?? "list";
      const workspaceDir = requireWorkspaceDir(ctx);

      const { project } = await resolveProject(workspaceDir, slug);

      if (action === "list") {
        const attachments = await listAttachments(workspaceDir, project.slug, issueId);
        return jsonResult({
          success: true,
          issueId,
          project: project.name,
          attachments: attachments.map((a) => ({
            id: a.id,
            filename: a.filename,
            mimeType: a.mimeType,
            size: a.size,
            uploader: a.uploader,
            uploadedAt: a.uploadedAt,
            publicUrl: a.publicUrl ?? null,
            localPath: getAttachmentPath(workspaceDir, project.slug, issueId, a.localPath),
          })),
          count: attachments.length,
        });
      }

      if (action === "get") {
        const attachmentId = params.attachmentId as string;
        if (!attachmentId) throw new Error("attachmentId is required for 'get' action");

        const attachments = await listAttachments(workspaceDir, project.slug, issueId);
        const attachment = attachments.find((a) => a.id === attachmentId);
        if (!attachment) throw new Error(`Attachment ${attachmentId} not found on issue #${issueId}`);

        return jsonResult({
          success: true,
          issueId,
          project: project.name,
          attachment: {
            ...attachment,
            fullPath: getAttachmentPath(workspaceDir, project.slug, issueId, attachment.localPath),
          },
        });
      }

      if (action === "add") {
        const filePath = params.filePath as string;
        if (!filePath) throw new Error("filePath is required for 'add' action");

        const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
        const buffer = await fs.readFile(resolvedPath);
        const filename = path.basename(resolvedPath);

        // Detect mime type from extension
        const { extensionForMime, detectMime } = await import("openclaw/plugin-sdk");
        const mimeType = await detectMime({ filePath: resolvedPath, buffer }) ?? "application/octet-stream";

        const meta = await saveAttachment(workspaceDir, project.slug, issueId, {
          buffer,
          filename,
          mimeType,
          uploader: "manual",
        });

        // Post comment on issue
        const { provider } = await resolveProvider(project);
        const comment = formatAttachmentComment([meta]);
        await provider.addComment(issueId, comment);

        await auditLog(workspaceDir, "task_attach", {
          project: project.name,
          issueId,
          filename,
          size: buffer.length,
          mimeType,
        });

        return jsonResult({
          success: true,
          issueId,
          project: project.name,
          attachment: {
            id: meta.id,
            filename: meta.filename,
            mimeType: meta.mimeType,
            size: meta.size,
            localPath: getAttachmentPath(workspaceDir, project.slug, issueId, meta.localPath),
          },
          announcement: `📎 File "${filename}" attached to #${issueId}`,
        });
      }

      throw new Error(`Unknown action: ${action}. Use 'list', 'add', or 'get'.`);
    },
  });
}
