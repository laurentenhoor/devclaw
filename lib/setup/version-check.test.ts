/**
 * Tests for version-check.ts — version checking for defaults upgrades.
 * Run with: npx tsx --test lib/setup/version-check.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { checkVersionStatus, getNotificationState, updateNotificationState } from "./version-check.js";

describe("version-check", () => {
  describe("checkVersionStatus", () => {
    it("should handle fresh install (no manifest)", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-version-"));
      
      const status = await checkVersionStatus(tmpDir);
      
      // Without manifest, may return error or up-to-date depending on file availability
      // Just verify it doesn't crash
      assert.ok(status.status);
      assert.ok(status.description);
      
      await fs.rm(tmpDir, { recursive: true });
    });
  });

  describe("notification state", () => {
    it("should store and retrieve notification state", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-notify-"));
      
      // Create a minimal .INSTALLED_DEFAULTS file
      const manifestPath = path.join(tmpDir, ".INSTALLED_DEFAULTS");
      await fs.writeFile(manifestPath, JSON.stringify({
        version: "1.4.0",
        createdAt: new Date().toISOString(),
        files: {},
      }), "utf-8");
      
      // Should return null initially
      const initialState = await getNotificationState(tmpDir);
      assert.strictEqual(initialState, null);
      
      // Update notification state
      await updateNotificationState(tmpDir, "1.5.0");
      
      // Should now return the updated version
      const updatedState = await getNotificationState(tmpDir);
      assert.strictEqual(updatedState, "1.5.0");
      
      await fs.rm(tmpDir, { recursive: true });
    });

    it("should handle missing manifest gracefully", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-notify-"));
      
      const state = await getNotificationState(tmpDir);
      assert.strictEqual(state, null);
      
      // Update should not fail even without existing manifest
      await updateNotificationState(tmpDir, "1.5.0");
      
      await fs.rm(tmpDir, { recursive: true });
    });
  });
});
