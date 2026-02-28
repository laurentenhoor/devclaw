/**
 * version.test.ts — Tests for version tracking.
 *
 * Run: npx tsx --test lib/setup/version.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { getCurrentVersion, readVersionFile, writeVersionFile, detectUpgrade } from "./version.js";

let tmpDir: string;

afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("version tracking", () => {
  it("getCurrentVersion returns a non-empty string", () => {
    const version = getCurrentVersion();
    assert.ok(version.length > 0);
    assert.ok(/^\d+\.\d+\.\d+/.test(version), `Expected semver, got: ${version}`);
  });

  it("readVersionFile returns null when no file exists", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-ver-test-"));
    const result = await readVersionFile(tmpDir);
    assert.strictEqual(result, null);
  });

  it("writeVersionFile creates a .version file", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-ver-test-"));
    await writeVersionFile(tmpDir);
    const content = await fs.readFile(path.join(tmpDir, ".version"), "utf-8");
    assert.strictEqual(content.trim(), getCurrentVersion());
  });

  it("detectUpgrade returns null on first run", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-ver-test-"));
    const result = await detectUpgrade(tmpDir);
    assert.strictEqual(result, null);
  });

  it("detectUpgrade returns null when versions match", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-ver-test-"));
    await writeVersionFile(tmpDir);
    const result = await detectUpgrade(tmpDir);
    assert.strictEqual(result, null);
  });

  it("detectUpgrade detects version change", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-ver-test-"));
    await fs.writeFile(path.join(tmpDir, ".version"), "1.0.0\n", "utf-8");
    const result = await detectUpgrade(tmpDir);
    assert.ok(result !== null);
    assert.strictEqual(result!.from, "1.0.0");
    assert.strictEqual(result!.to, getCurrentVersion());
  });
});
