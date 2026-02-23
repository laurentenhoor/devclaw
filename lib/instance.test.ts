import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadInstanceName } from "./instance.js";
import { DATA_DIR } from "./setup/migrate-layout.js";

describe("loadInstanceName", () => {
  let tmpDir: string;

  async function createWorkspace(): Promise<string> {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devclaw-instance-test-"));
    await fs.mkdir(path.join(tmpDir, DATA_DIR), { recursive: true });
    return tmpDir;
  }

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("auto-generates and persists a name on first call", async () => {
    const ws = await createWorkspace();
    const name = await loadInstanceName(ws);
    expect(name).toBeTruthy();
    expect(typeof name).toBe("string");

    // Persisted to file
    const raw = await fs.readFile(path.join(ws, DATA_DIR, "instance.json"), "utf-8");
    const data = JSON.parse(raw);
    expect(data.name).toBe(name);
    expect(data.createdAt).toBeTruthy();
  });

  it("returns the same name on subsequent calls", async () => {
    const ws = await createWorkspace();
    const first = await loadInstanceName(ws);
    const second = await loadInstanceName(ws);
    expect(first).toBe(second);
  });

  it("uses config override when provided", async () => {
    const ws = await createWorkspace();
    const name = await loadInstanceName(ws, "CustomBot");
    expect(name).toBe("CustomBot");
  });

  it("config override takes precedence over persisted name", async () => {
    const ws = await createWorkspace();
    // Generate and persist a name
    const autoName = await loadInstanceName(ws);
    // Override should win
    const overrideName = await loadInstanceName(ws, "Override");
    expect(overrideName).toBe("Override");
    expect(overrideName).not.toBe(autoName);
  });
});
