/**
 * Tests for backup-manager.ts — backup management for defaults upgrades.
 * Run with: npx tsx --test lib/tools/backup-manager.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { isOldBackup, formatBackupInfo } from "./backup-manager.js";
import type { BackupInfo } from "./backup-manager.js";

describe("backup-manager", () => {
  describe("isOldBackup", () => {
    it("should return true for backups >30 days old", () => {
      const oldTimestamp = Date.now() - 31 * 24 * 60 * 60 * 1000;
      assert.strictEqual(isOldBackup(oldTimestamp), true);
    });

    it("should return false for recent backups", () => {
      const recentTimestamp = Date.now() - 5 * 24 * 60 * 60 * 1000;
      assert.strictEqual(isOldBackup(recentTimestamp), false);
    });

    it("should return false for backups exactly 30 days old", () => {
      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
      assert.strictEqual(isOldBackup(thirtyDaysAgo), false);
    });
  });

  describe("formatBackupInfo", () => {
    it("should format backup info with version transition", () => {
      const backup: BackupInfo = {
        timestamp: 1726052400000,
        date: "2026-02-20",
        fromVersion: "1.4.0",
        toVersion: "1.5.0",
        files: 3,
        backupPaths: [],
      };

      const formatted = formatBackupInfo(backup, 0);
      
      assert.ok(formatted.includes("1. Timestamp: 1726052400000"));
      assert.ok(formatted.includes("Version: 1.4.0 → 1.5.0"));
      assert.ok(formatted.includes("Files: 3"));
      assert.ok(formatted.includes("openclaw devclaw upgrade-defaults --rollback --timestamp 1726052400000"));
    });

    it("should include warning for old backups", () => {
      const oldTimestamp = Date.now() - 31 * 24 * 60 * 60 * 1000;
      const backup: BackupInfo = {
        timestamp: oldTimestamp,
        date: "2025-12-20",
        fromVersion: "1.3.0",
        toVersion: null,
        files: 2,
        backupPaths: [],
      };

      const formatted = formatBackupInfo(backup, 1);
      
      assert.ok(formatted.includes("⚠️ (>30 days old)"));
    });

    it("should handle missing toVersion", () => {
      const backup: BackupInfo = {
        timestamp: 1726052400000,
        date: "2026-02-20",
        fromVersion: "1.4.0",
        toVersion: null,
        files: 1,
        backupPaths: [],
      };

      const formatted = formatBackupInfo(backup, 0);
      
      assert.ok(formatted.includes("Version: 1.4.0"));
      assert.ok(!formatted.includes("→"));
    });
  });
});
