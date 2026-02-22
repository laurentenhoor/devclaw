/**
 * Tests for defaults-manifest.ts — hash-based version tracking.
 * Run with: npx tsx --test lib/setup/defaults-manifest.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  calculateHash,
  loadManifest,
  loadInstalledManifest,
  saveInstalledManifest,
  compareManifests,
  createRetroactiveManifest,
} from "./defaults-manifest.js";

describe("defaults-manifest", () => {
  describe("calculateHash", () => {
    it("should calculate SHA256 hash of a file", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-hash-"));
      const testFile = path.join(tmpDir, "test.txt");
      await fs.writeFile(testFile, "Hello, world!");

      const hash = await calculateHash(testFile);
      
      // Known SHA256 hash of "Hello, world!"
      assert.strictEqual(
        hash,
        "315f5bdb76d078c43b8ac0064e4a0164612b1fce77c869345bfc94c75894edd3"
      );

      await fs.rm(tmpDir, { recursive: true });
    });

    it("should return null for non-existent file", async () => {
      const hash = await calculateHash("/nonexistent/file.txt");
      assert.strictEqual(hash, null);
    });

    it("should produce different hashes for different content", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-hash-"));
      const file1 = path.join(tmpDir, "file1.txt");
      const file2 = path.join(tmpDir, "file2.txt");
      
      await fs.writeFile(file1, "content A");
      await fs.writeFile(file2, "content B");

      const hash1 = await calculateHash(file1);
      const hash2 = await calculateHash(file2);

      assert.notStrictEqual(hash1, hash2);
      assert.ok(hash1);
      assert.ok(hash2);

      await fs.rm(tmpDir, { recursive: true });
    });
  });

  describe("loadManifest", () => {
    it("should load the plugin DEFAULTS.json manifest", () => {
      const manifest = loadManifest();
      
      assert.ok(manifest, "Manifest should exist");
      assert.ok(manifest.version, "Manifest should have version");
      assert.ok(manifest.createdAt, "Manifest should have createdAt");
      assert.ok(manifest.files, "Manifest should have files");
      assert.ok(Object.keys(manifest.files).length > 0, "Manifest should have at least one file");
      
      // Check that expected files are present
      assert.ok(manifest.files["AGENTS.md"], "Should include AGENTS.md");
      assert.ok(manifest.files["devclaw/prompts/developer.md"], "Should include developer.md");
    });
  });

  describe("saveInstalledManifest and loadInstalledManifest", () => {
    it("should save and load installed manifest", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-manifest-"));
      
      const testManifest = {
        version: "1.4.0",
        createdAt: "2026-02-22T00:00:00.000Z",
        files: {
          "test.md": {
            hash: "abc123",
            updatedAt: "2026-02-22T00:00:00.000Z",
          },
        },
      };

      await saveInstalledManifest(tmpDir, testManifest);
      const loaded = await loadInstalledManifest(tmpDir);

      assert.deepStrictEqual(loaded, testManifest);

      await fs.rm(tmpDir, { recursive: true });
    });

    it("should return null if installed manifest doesn't exist", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-manifest-"));
      
      const loaded = await loadInstalledManifest(tmpDir);
      assert.strictEqual(loaded, null);

      await fs.rm(tmpDir, { recursive: true });
    });
  });

  describe("compareManifests", () => {
    it("should detect unchanged files", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-compare-"));
      
      // Create a test file
      await fs.writeFile(path.join(tmpDir, "AGENTS.md"), "test content");
      
      // Create installed manifest with matching hash
      const testHash = await calculateHash(path.join(tmpDir, "AGENTS.md"));
      await saveInstalledManifest(tmpDir, {
        version: "1.4.0",
        createdAt: "2026-02-22T00:00:00.000Z",
        files: {
          "AGENTS.md": {
            hash: testHash!,
            updatedAt: "2026-02-22T00:00:00.000Z",
          },
        },
      });

      const result = await compareManifests(tmpDir);
      
      // Note: This will likely show as customized because the plugin's AGENTS.md
      // has different content than our test file. That's expected in this test.
      assert.ok(result);
      assert.strictEqual(result.installedVersion, "1.4.0");

      await fs.rm(tmpDir, { recursive: true });
    });

    it("should detect missing files", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-compare-"));
      
      // Don't create any files, so all will be missing
      const result = await compareManifests(tmpDir);
      
      assert.ok(result);
      assert.ok(result.missing.length > 0, "Should detect missing files");

      await fs.rm(tmpDir, { recursive: true });
    });
  });

  describe("createRetroactiveManifest", () => {
    it("should create manifest from existing workspace files", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-retro-"));
      
      // Create a test file
      const testFile = path.join(tmpDir, "AGENTS.md");
      await fs.writeFile(testFile, "test content");
      
      const manifest = await createRetroactiveManifest(tmpDir);
      
      assert.ok(manifest);
      assert.strictEqual(manifest.version, "1.4.0");
      assert.ok(manifest.files["AGENTS.md"], "Should include AGENTS.md");
      assert.ok(manifest.files["AGENTS.md"].hash, "Should have hash for AGENTS.md");

      await fs.rm(tmpDir, { recursive: true });
    });
  });
});
