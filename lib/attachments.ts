/**
 * attachments.ts — Telegram attachment capture and issue association.
 *
 * Flow:
 *   1. message_received hook detects attachments in metadata
 *   2. Files are downloaded from Telegram Bot API to local storage
 *   3. Metadata is persisted to a JSON store per project
 *   4. A comment is posted on the associated GitHub/GitLab issue
 *   5. Attachments are available for architects/developers in task context
 *
 * Storage layout:
 *   devclaw/attachments/<projectSlug>/<issueId>/<uuid>-<filename>
 *   devclaw/attachments/<projectSlug>/<issueId>/metadata.json
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "./setup/migrate-layout.js";
import type { IssueProvider } from "./providers/provider.js";
import { log as auditLog } from "./audit.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AttachmentMeta = {
  id: string;
  issueId: number;
  filename: string;
  mimeType: string;
  size: number;
  uploader: string;
  uploadedAt: string;
  /** Local path relative to workspace attachments dir */
  localPath: string;
  /** Public URL if uploaded to GitHub/GitLab */
  publicUrl?: string;
};

export type AttachmentStore = {
  attachments: AttachmentMeta[];
};

// ---------------------------------------------------------------------------
// Channel-agnostic media extraction
// ---------------------------------------------------------------------------

/**
 * Extracted media info from any channel's message metadata.
 * OpenClaw downloads media from all channels (Telegram, Discord, WhatsApp, etc.)
 * and stores it locally, exposing MediaPath/MediaPaths in the message context.
 */
export type MediaAttachmentInfo = {
  /** Local file path (already downloaded by OpenClaw) */
  localPath: string;
  /** MIME type if known */
  mimeType?: string;
  /** Original filename */
  filename?: string;
};

/**
 * Extract media attachments from message metadata (channel-agnostic).
 *
 * OpenClaw normalizes all channel media into a common format:
 * - MediaPath: single file path (string)
 * - MediaPaths: multiple file paths (string[])
 * - MediaType/MediaTypes: corresponding MIME types
 *
 * This works for Telegram, Discord, WhatsApp, Signal, Slack, etc.
 */
export function extractMediaAttachments(
  metadata: Record<string, unknown>,
): MediaAttachmentInfo[] {
  const attachments: MediaAttachmentInfo[] = [];

  // Collect all paths
  const paths: string[] = [];
  const types: string[] = [];

  if (typeof metadata.MediaPath === "string" && metadata.MediaPath) {
    paths.push(metadata.MediaPath);
  }
  if (Array.isArray(metadata.MediaPaths)) {
    for (const p of metadata.MediaPaths) {
      if (typeof p === "string" && p) paths.push(p);
    }
  }

  if (typeof metadata.MediaType === "string" && metadata.MediaType) {
    types.push(metadata.MediaType);
  }
  if (Array.isArray(metadata.MediaTypes)) {
    for (const t of metadata.MediaTypes) {
      if (typeof t === "string" && t) types.push(t);
    }
  }

  for (let i = 0; i < paths.length; i++) {
    const localPath = paths[i];
    const mimeType = types[i] ?? undefined;
    const filename = path.basename(localPath);
    attachments.push({ localPath, mimeType, filename });
  }

  return attachments;
}

// ---------------------------------------------------------------------------
// Issue reference extraction
// ---------------------------------------------------------------------------

/**
 * Extract issue references from message text.
 * Supports: #42, issue #42, fix #42, addresses #42
 */
export function extractIssueReferences(text: string): number[] {
  const matches = text.matchAll(/#(\d+)/g);
  const ids = new Set<number>();
  for (const m of matches) {
    const id = parseInt(m[1], 10);
    if (id > 0 && id < 100000) ids.add(id);
  }
  return [...ids];
}

// ---------------------------------------------------------------------------
// Storage operations
// ---------------------------------------------------------------------------

function attachmentsDir(workspaceDir: string, projectSlug: string, issueId: number): string {
  return path.join(workspaceDir, DATA_DIR, "attachments", projectSlug, String(issueId));
}

function metadataPath(workspaceDir: string, projectSlug: string, issueId: number): string {
  return path.join(attachmentsDir(workspaceDir, projectSlug, issueId), "metadata.json");
}

async function readStore(workspaceDir: string, projectSlug: string, issueId: number): Promise<AttachmentStore> {
  try {
    const raw = await fs.readFile(metadataPath(workspaceDir, projectSlug, issueId), "utf-8");
    return JSON.parse(raw) as AttachmentStore;
  } catch {
    return { attachments: [] };
  }
}

async function writeStore(workspaceDir: string, projectSlug: string, issueId: number, store: AttachmentStore): Promise<void> {
  const dir = attachmentsDir(workspaceDir, projectSlug, issueId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(metadataPath(workspaceDir, projectSlug, issueId), JSON.stringify(store, null, 2));
}

/**
 * Save a downloaded file to the attachment store and record metadata.
 */
export async function saveAttachment(
  workspaceDir: string,
  projectSlug: string,
  issueId: number,
  file: {
    buffer: Buffer;
    filename: string;
    mimeType: string;
    uploader: string;
  },
): Promise<AttachmentMeta> {
  const id = crypto.randomUUID();
  const safeFilename = file.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const storedName = `${id.slice(0, 8)}-${safeFilename}`;
  const dir = attachmentsDir(workspaceDir, projectSlug, issueId);
  await fs.mkdir(dir, { recursive: true });

  const filePath = path.join(dir, storedName);
  await fs.writeFile(filePath, file.buffer);

  const meta: AttachmentMeta = {
    id,
    issueId,
    filename: file.filename,
    mimeType: file.mimeType,
    size: file.buffer.length,
    uploader: file.uploader,
    uploadedAt: new Date().toISOString(),
    localPath: storedName,
  };

  const store = await readStore(workspaceDir, projectSlug, issueId);
  store.attachments.push(meta);
  await writeStore(workspaceDir, projectSlug, issueId, store);

  return meta;
}

/**
 * List all attachments for an issue.
 */
export async function listAttachments(
  workspaceDir: string,
  projectSlug: string,
  issueId: number,
): Promise<AttachmentMeta[]> {
  const store = await readStore(workspaceDir, projectSlug, issueId);
  return store.attachments;
}

/**
 * Get the full local path for an attachment.
 */
export function getAttachmentPath(
  workspaceDir: string,
  projectSlug: string,
  issueId: number,
  localPath: string,
): string {
  return path.join(attachmentsDir(workspaceDir, projectSlug, issueId), localPath);
}

// ---------------------------------------------------------------------------
// GitHub/GitLab issue comment with attachment
// ---------------------------------------------------------------------------

/**
 * Format an attachment comment for posting on an issue.
 */
export function formatAttachmentComment(attachments: AttachmentMeta[]): string {
  if (attachments.length === 0) return "";

  const lines = ["📎 **Attachment(s) added via Telegram:**", ""];
  for (const a of attachments) {
    const sizeStr = formatSize(a.size);
    const isImage = a.mimeType.startsWith("image/");
    if (isImage && a.publicUrl) {
      lines.push(`![${a.filename}](${a.publicUrl})`);
      lines.push(`*${a.filename}* (${sizeStr}) — uploaded by ${a.uploader}`);
    } else if (a.publicUrl) {
      lines.push(`- [${a.filename}](${a.publicUrl}) (${a.mimeType}, ${sizeStr}) — uploaded by ${a.uploader}`);
    } else {
      lines.push(`- **${a.filename}** (${a.mimeType}, ${sizeStr}) — uploaded by ${a.uploader}`);
      lines.push(`  _File stored locally. Use \`task_attach\` tool to access._`);
    }
  }

  lines.push("", `_Attached at ${new Date().toISOString()}_`);
  return lines.join("\n");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Main processing function
// ---------------------------------------------------------------------------

/**
 * Process a message with media attachments and associate with an issue.
 *
 * Channel-agnostic: works with any channel (Telegram, Discord, WhatsApp, etc.)
 * since OpenClaw normalizes all media into local file paths via MediaPath/MediaPaths.
 *
 * Called by the message_received hook when media is detected.
 */
export async function processAttachmentMessage(opts: {
  workspaceDir: string;
  projectSlug: string;
  issueId: number;
  provider: IssueProvider;
  uploader: string;
  mediaAttachments: MediaAttachmentInfo[];
}): Promise<AttachmentMeta[]> {
  const {
    workspaceDir, projectSlug, issueId, provider,
    uploader, mediaAttachments,
  } = opts;

  const saved: AttachmentMeta[] = [];

  for (const media of mediaAttachments) {
    try {
      // Read the file from local path (already downloaded by OpenClaw)
      const buffer = await fs.readFile(media.localPath);
      const filename = media.filename ?? path.basename(media.localPath);
      const mimeType = media.mimeType ?? "application/octet-stream";

      // Save to attachment store
      const meta = await saveAttachment(workspaceDir, projectSlug, issueId, {
        buffer,
        filename,
        mimeType,
        uploader,
      });

      // Upload to GitHub/GitLab via the provider
      let publicUrl: string | null = null;
      try {
        publicUrl = await provider.uploadAttachment(issueId, { filename, buffer, mimeType });
      } catch (uploadErr) {
        await auditLog(workspaceDir, "attachment_upload_error", {
          project: projectSlug, issueId, filename,
          error: (uploadErr as Error).message ?? String(uploadErr),
        });
      }

      if (publicUrl) {
        meta.publicUrl = publicUrl;
        // Update store with public URL
        const store = await readStore(workspaceDir, projectSlug, issueId);
        const idx = store.attachments.findIndex((a) => a.id === meta.id);
        if (idx >= 0) {
          store.attachments[idx].publicUrl = publicUrl;
          await writeStore(workspaceDir, projectSlug, issueId, store);
        }
      }

      saved.push(meta);
    } catch (err) {
      await auditLog(workspaceDir, "attachment_error", {
        project: projectSlug,
        issueId,
        file: media.localPath,
        error: (err as Error).message ?? String(err),
      });
    }
  }

  // Post comment on issue with attachment info
  if (saved.length > 0) {
    const comment = formatAttachmentComment(saved);
    try {
      await provider.addComment(issueId, comment);
    } catch (err) {
      await auditLog(workspaceDir, "attachment_comment_error", {
        project: projectSlug,
        issueId,
        error: (err as Error).message ?? String(err),
      });
    }

    await auditLog(workspaceDir, "attachments_added", {
      project: projectSlug,
      issueId,
      count: saved.length,
      files: saved.map((a) => ({ filename: a.filename, size: a.size, mimeType: a.mimeType })),
      uploader,
    });
  }

  return saved;
}

// ---------------------------------------------------------------------------
// Context enrichment — include attachment info in task messages
// ---------------------------------------------------------------------------

/**
 * Format attachment metadata for inclusion in task context.
 * Returns empty string if no attachments exist.
 */
export async function formatAttachmentsForTask(
  workspaceDir: string,
  projectSlug: string,
  issueId: number,
): Promise<string> {
  const attachments = await listAttachments(workspaceDir, projectSlug, issueId);
  if (attachments.length === 0) return "";

  const lines = ["", "## Attachments", ""];
  for (const a of attachments) {
    const sizeStr = formatSize(a.size);
    const date = new Date(a.uploadedAt).toLocaleString();
    if (a.publicUrl) {
      lines.push(`- [${a.filename}](${a.publicUrl}) (${a.mimeType}, ${sizeStr}) — by ${a.uploader} on ${date}`);
    } else {
      const fullPath = path.join(
        workspaceDir, DATA_DIR, "attachments", projectSlug, String(issueId), a.localPath,
      );
      lines.push(`- ${a.filename} (${a.mimeType}, ${sizeStr}) — by ${a.uploader} on ${date}`);
      lines.push(`  Local path: ${fullPath}`);
    }
  }

  return lines.join("\n");
}
