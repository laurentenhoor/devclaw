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
  /** Original Telegram file_id for re-download if needed */
  telegramFileId?: string;
  /** Public URL if uploaded to GitHub/GitLab */
  publicUrl?: string;
};

export type AttachmentStore = {
  attachments: AttachmentMeta[];
};

// ---------------------------------------------------------------------------
// Telegram message metadata shape (from OpenClaw message_received hook)
// ---------------------------------------------------------------------------

export type TelegramAttachmentInfo = {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_name?: string;
  mime_type?: string;
  width?: number;
  height?: number;
};

/**
 * Extract attachment info from Telegram message metadata.
 * Telegram sends different fields depending on media type:
 * - photo: array of PhotoSize (we pick largest)
 * - document: Document object
 * - video: Video object
 * - audio: Audio object
 * - voice: Voice object
 * - video_note: VideoNote object
 * - sticker: Sticker object
 */
export function extractTelegramAttachments(
  metadata: Record<string, unknown>,
): TelegramAttachmentInfo[] {
  const attachments: TelegramAttachmentInfo[] = [];

  // Photo — array of sizes, pick the largest
  const photo = metadata.photo as Array<TelegramAttachmentInfo> | undefined;
  if (Array.isArray(photo) && photo.length > 0) {
    const largest = photo.reduce((best, cur) =>
      (cur.file_size ?? 0) > (best.file_size ?? 0) ? cur : best,
    );
    attachments.push({
      ...largest,
      mime_type: largest.mime_type ?? "image/jpeg",
      file_name: largest.file_name ?? `photo-${largest.file_unique_id}.jpg`,
    });
  }

  // Document
  const doc = metadata.document as TelegramAttachmentInfo | undefined;
  if (doc?.file_id) {
    attachments.push({
      ...doc,
      mime_type: doc.mime_type ?? "application/octet-stream",
      file_name: doc.file_name ?? `document-${doc.file_unique_id}`,
    });
  }

  // Video
  const video = metadata.video as TelegramAttachmentInfo | undefined;
  if (video?.file_id) {
    attachments.push({
      ...video,
      mime_type: video.mime_type ?? "video/mp4",
      file_name: video.file_name ?? `video-${video.file_unique_id}.mp4`,
    });
  }

  // Audio
  const audio = metadata.audio as TelegramAttachmentInfo | undefined;
  if (audio?.file_id) {
    attachments.push({
      ...audio,
      mime_type: audio.mime_type ?? "audio/mpeg",
      file_name: audio.file_name ?? `audio-${audio.file_unique_id}.mp3`,
    });
  }

  // Voice
  const voice = metadata.voice as TelegramAttachmentInfo | undefined;
  if (voice?.file_id) {
    attachments.push({
      ...voice,
      mime_type: voice.mime_type ?? "audio/ogg",
      file_name: voice.file_name ?? `voice-${voice.file_unique_id}.ogg`,
    });
  }

  // Video note (round videos)
  const videoNote = metadata.video_note as TelegramAttachmentInfo | undefined;
  if (videoNote?.file_id) {
    attachments.push({
      ...videoNote,
      mime_type: videoNote.mime_type ?? "video/mp4",
      file_name: videoNote.file_name ?? `videonote-${videoNote.file_unique_id}.mp4`,
    });
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
    telegramFileId?: string;
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
    telegramFileId: file.telegramFileId,
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
// Telegram file download
// ---------------------------------------------------------------------------

/**
 * Download a file from Telegram Bot API.
 * Requires TELEGRAM_BOT_TOKEN environment variable.
 */
export async function downloadTelegramFile(fileId: string): Promise<{ buffer: Buffer; filePath: string }> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN environment variable is required for file downloads");
  }

  // Step 1: Get file path from Telegram
  const fileInfoUrl = `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`;
  const fileInfoRes = await fetch(fileInfoUrl);
  if (!fileInfoRes.ok) {
    throw new Error(`Telegram getFile failed: ${fileInfoRes.status} ${fileInfoRes.statusText}`);
  }
  const fileInfo = (await fileInfoRes.json()) as {
    ok: boolean;
    result?: { file_path: string; file_size?: number };
  };
  if (!fileInfo.ok || !fileInfo.result?.file_path) {
    throw new Error("Telegram getFile returned no file_path");
  }

  // Step 2: Download the file
  const downloadUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.result.file_path}`;
  const downloadRes = await fetch(downloadUrl);
  if (!downloadRes.ok) {
    throw new Error(`Telegram file download failed: ${downloadRes.status}`);
  }

  const buffer = Buffer.from(await downloadRes.arrayBuffer());
  return { buffer, filePath: fileInfo.result.file_path };
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
// GitHub upload via repository content API
// ---------------------------------------------------------------------------

/**
 * Upload a file to GitHub as a repository asset and return the raw URL.
 * Uses a dedicated `devclaw-attachments` branch to avoid polluting main.
 * Falls back gracefully if upload fails (attachment is still stored locally).
 */
export async function uploadToGitHub(
  repoPath: string,
  projectSlug: string,
  issueId: number,
  attachment: AttachmentMeta,
  fileBuffer: Buffer,
): Promise<string | null> {
  try {
    const { runCommand } = await import("./run-command.js");

    // Use the GitHub API to upload via issue comment (most reliable cross-platform method)
    // GitHub allows file references in issue comments. We use the repository content API
    // to store the file on a special branch and link to the raw content.
    const branch = "devclaw-attachments";
    const filePath = `attachments/${projectSlug}/${issueId}/${attachment.localPath}`;
    const base64Content = fileBuffer.toString("base64");

    // Ensure branch exists (create from default branch if not)
    try {
      await runCommand(
        ["gh", "api", "repos/:owner/:repo/git/ref/heads/" + branch],
        { timeoutMs: 15_000, cwd: repoPath },
      );
    } catch {
      // Branch doesn't exist — create it from default branch
      try {
        const defaultBranchRaw = await runCommand(
          ["gh", "repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
          { timeoutMs: 15_000, cwd: repoPath },
        );
        const defaultBranch = defaultBranchRaw.stdout.trim();
        const shaRaw = await runCommand(
          ["gh", "api", `repos/:owner/:repo/git/ref/heads/${defaultBranch}`, "--jq", ".object.sha"],
          { timeoutMs: 15_000, cwd: repoPath },
        );
        const sha = shaRaw.stdout.trim();
        await runCommand(
          ["gh", "api", "repos/:owner/:repo/git/refs", "--method", "POST",
            "--field", `ref=refs/heads/${branch}`,
            "--field", `sha=${sha}`],
          { timeoutMs: 15_000, cwd: repoPath },
        );
      } catch {
        // Can't create branch — fall back to local-only storage
        return null;
      }
    }

    // Upload file content
    try {
      const payload = JSON.stringify({
        message: `attachment: ${attachment.filename} for issue #${issueId}`,
        content: base64Content,
        branch,
      });
      const result = await runCommand(
        ["gh", "api", `repos/:owner/:repo/contents/${filePath}`,
          "--method", "PUT",
          "--input", "-"],
        { timeoutMs: 30_000, cwd: repoPath, input: payload },
      );
      const parsed = JSON.parse(result.stdout);
      return parsed.content?.download_url ?? null;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// GitLab upload via project upload API
// ---------------------------------------------------------------------------

/**
 * Upload a file to GitLab using the project uploads API.
 * Returns the markdown-compatible URL for embedding.
 */
export async function uploadToGitLab(
  repoPath: string,
  attachment: AttachmentMeta,
  filePath: string,
): Promise<string | null> {
  try {
    const { runCommand } = await import("./run-command.js");

    // GitLab has a native uploads endpoint: POST /projects/:id/uploads
    // Use glab to get the project path, then upload via API
    const projectRaw = await runCommand(
      ["glab", "api", "projects/:id", "--method", "GET"],
      { timeoutMs: 15_000, cwd: repoPath },
    );
    const project = JSON.parse(projectRaw.stdout);
    const projectId = project.id;
    const webUrl = project.web_url;

    // Upload using multipart form data via curl (glab doesn't support file upload directly)
    const result = await runCommand(
      ["curl", "--silent", "--fail",
        "--header", `PRIVATE-TOKEN: $(glab config get token)`,
        "--form", `file=@${filePath}`,
        `${webUrl.replace(/\/$/, "")}/api/v4/projects/${projectId}/uploads`],
      { timeoutMs: 30_000, cwd: repoPath },
    );
    const parsed = JSON.parse(result.stdout);
    return parsed.full_path ? `${webUrl}${parsed.full_path}` : (parsed.url ?? null);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main processing function
// ---------------------------------------------------------------------------

/**
 * Process a Telegram message with attachments and associate with an issue.
 *
 * Called by the message_received hook when media is detected.
 */
export async function processAttachmentMessage(opts: {
  workspaceDir: string;
  projectSlug: string;
  issueId: number;
  provider: IssueProvider;
  providerType: "github" | "gitlab";
  repoPath: string;
  uploader: string;
  telegramAttachments: TelegramAttachmentInfo[];
}): Promise<AttachmentMeta[]> {
  const {
    workspaceDir, projectSlug, issueId, provider,
    providerType, repoPath, uploader, telegramAttachments,
  } = opts;

  const saved: AttachmentMeta[] = [];

  for (const tgFile of telegramAttachments) {
    try {
      // Download from Telegram
      const { buffer } = await downloadTelegramFile(tgFile.file_id);

      // Save locally
      const meta = await saveAttachment(workspaceDir, projectSlug, issueId, {
        buffer,
        filename: tgFile.file_name ?? "unnamed",
        mimeType: tgFile.mime_type ?? "application/octet-stream",
        uploader,
        telegramFileId: tgFile.file_id,
      });

      // Try to upload to GitHub/GitLab for public URL
      const localFilePath = getAttachmentPath(workspaceDir, projectSlug, issueId, meta.localPath);
      let publicUrl: string | null = null;

      if (providerType === "github") {
        publicUrl = await uploadToGitHub(repoPath, projectSlug, issueId, meta, buffer);
      } else if (providerType === "gitlab") {
        publicUrl = await uploadToGitLab(repoPath, meta, localFilePath);
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
        fileId: tgFile.file_id,
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
