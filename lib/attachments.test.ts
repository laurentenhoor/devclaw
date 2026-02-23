/**
 * Tests for attachments.ts — Telegram attachment extraction, storage, and formatting.
 * Run with: npx tsx --test lib/attachments.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  extractTelegramAttachments,
  extractIssueReferences,
  saveAttachment,
  listAttachments,
  getAttachmentPath,
  formatAttachmentComment,
  formatAttachmentsForTask,
} from "./attachments.js";

describe("extractTelegramAttachments", () => {
  it("extracts photo (picks largest)", () => {
    const metadata = {
      photo: [
        { file_id: "small", file_unique_id: "s1", file_size: 100, width: 90, height: 90 },
        { file_id: "large", file_unique_id: "l1", file_size: 5000, width: 800, height: 600 },
        { file_id: "medium", file_unique_id: "m1", file_size: 1000, width: 320, height: 240 },
      ],
    };
    const result = extractTelegramAttachments(metadata);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].file_id, "large");
    assert.strictEqual(result[0].mime_type, "image/jpeg");
  });

  it("extracts document", () => {
    const metadata = {
      document: {
        file_id: "doc1",
        file_unique_id: "du1",
        file_name: "report.pdf",
        mime_type: "application/pdf",
        file_size: 12345,
      },
    };
    const result = extractTelegramAttachments(metadata);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].file_name, "report.pdf");
    assert.strictEqual(result[0].mime_type, "application/pdf");
  });

  it("extracts video", () => {
    const metadata = {
      video: { file_id: "vid1", file_unique_id: "vu1", file_size: 50000 },
    };
    const result = extractTelegramAttachments(metadata);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].mime_type, "video/mp4");
  });

  it("extracts audio", () => {
    const metadata = {
      audio: { file_id: "aud1", file_unique_id: "au1", mime_type: "audio/mp3", file_size: 3000 },
    };
    const result = extractTelegramAttachments(metadata);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].mime_type, "audio/mp3");
  });

  it("extracts voice", () => {
    const metadata = {
      voice: { file_id: "voi1", file_unique_id: "vo1", file_size: 2000 },
    };
    const result = extractTelegramAttachments(metadata);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].mime_type, "audio/ogg");
  });

  it("extracts multiple attachment types", () => {
    const metadata = {
      document: { file_id: "doc1", file_unique_id: "du1", file_name: "file.txt", mime_type: "text/plain", file_size: 100 },
      audio: { file_id: "aud1", file_unique_id: "au1", mime_type: "audio/mp3", file_size: 3000 },
    };
    const result = extractTelegramAttachments(metadata);
    assert.strictEqual(result.length, 2);
  });

  it("returns empty for no attachments", () => {
    const result = extractTelegramAttachments({});
    assert.strictEqual(result.length, 0);
  });
});

describe("extractIssueReferences", () => {
  it("extracts single reference", () => {
    assert.deepStrictEqual(extractIssueReferences("Fix this #42"), [42]);
  });

  it("extracts multiple references", () => {
    const refs = extractIssueReferences("See #42 and #13 and #42");
    assert.deepStrictEqual(refs, [42, 13]); // deduplicated
  });

  it("returns empty for no references", () => {
    assert.deepStrictEqual(extractIssueReferences("no issues here"), []);
  });

  it("ignores very large issue numbers", () => {
    assert.deepStrictEqual(extractIssueReferences("#999999"), []);
  });
});

describe("saveAttachment / listAttachments", () => {
  it("saves and lists attachments", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-attach-test-"));
    try {
      const buffer = Buffer.from("hello world");
      const meta = await saveAttachment(tmpDir, "test-project", 42, {
        buffer,
        filename: "test.txt",
        mimeType: "text/plain",
        uploader: "user123",
        telegramFileId: "tg_file_123",
      });

      assert.ok(meta.id);
      assert.strictEqual(meta.issueId, 42);
      assert.strictEqual(meta.filename, "test.txt");
      assert.strictEqual(meta.mimeType, "text/plain");
      assert.strictEqual(meta.size, 11);
      assert.strictEqual(meta.uploader, "user123");
      assert.strictEqual(meta.telegramFileId, "tg_file_123");

      // Verify file exists on disk
      const fullPath = getAttachmentPath(tmpDir, "test-project", 42, meta.localPath);
      const content = await fs.readFile(fullPath, "utf-8");
      assert.strictEqual(content, "hello world");

      // List should return the saved attachment
      const list = await listAttachments(tmpDir, "test-project", 42);
      assert.strictEqual(list.length, 1);
      assert.strictEqual(list[0].id, meta.id);

      // Save another
      await saveAttachment(tmpDir, "test-project", 42, {
        buffer: Buffer.from("image data"),
        filename: "photo.jpg",
        mimeType: "image/jpeg",
        uploader: "user456",
      });
      const list2 = await listAttachments(tmpDir, "test-project", 42);
      assert.strictEqual(list2.length, 2);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns empty list for non-existent issue", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-attach-test-"));
    try {
      const list = await listAttachments(tmpDir, "test-project", 999);
      assert.strictEqual(list.length, 0);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("formatAttachmentComment", () => {
  it("formats comment with public URL", () => {
    const comment = formatAttachmentComment([{
      id: "abc", issueId: 42, filename: "photo.jpg", mimeType: "image/jpeg",
      size: 5000, uploader: "alice", uploadedAt: "2024-01-01T00:00:00Z",
      localPath: "abc-photo.jpg", publicUrl: "https://example.com/photo.jpg",
    }]);
    assert.ok(comment.includes("![photo.jpg](https://example.com/photo.jpg)"));
    assert.ok(comment.includes("alice"));
  });

  it("formats comment without public URL", () => {
    const comment = formatAttachmentComment([{
      id: "abc", issueId: 42, filename: "data.csv", mimeType: "text/csv",
      size: 1000, uploader: "bob", uploadedAt: "2024-01-01T00:00:00Z",
      localPath: "abc-data.csv",
    }]);
    assert.ok(comment.includes("**data.csv**"));
    assert.ok(comment.includes("task_attach"));
  });

  it("returns empty for no attachments", () => {
    assert.strictEqual(formatAttachmentComment([]), "");
  });
});

describe("formatAttachmentsForTask", () => {
  it("returns empty string when no attachments", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-attach-test-"));
    try {
      const result = await formatAttachmentsForTask(tmpDir, "test-project", 999);
      assert.strictEqual(result, "");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("includes attachment info for existing attachments", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-attach-test-"));
    try {
      await saveAttachment(tmpDir, "test-project", 42, {
        buffer: Buffer.from("test"),
        filename: "readme.md",
        mimeType: "text/markdown",
        uploader: "charlie",
      });
      const result = await formatAttachmentsForTask(tmpDir, "test-project", 42);
      assert.ok(result.includes("## Attachments"));
      assert.ok(result.includes("readme.md"));
      assert.ok(result.includes("charlie"));
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
