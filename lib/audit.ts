/**
 * Append-only NDJSON audit logging.
 * Every tool call automatically logs — no manual action needed from agents.
 * Automatically truncates log to keep only last 250 lines.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { DATA_DIR } from "./setup/migrate-layout.js";

const MAX_LOG_LINES = 50;

export async function log(
  workspaceDir: string,
  event: string,
  data: Record<string, unknown>,
): Promise<void> {
  const filePath = join(workspaceDir, DATA_DIR, "log", "audit.log");
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    event,
    ...data,
  });
  try {
    await appendFile(filePath, entry + "\n");
    await truncateIfNeeded(filePath);
  } catch (err: unknown) {
    // If directory doesn't exist, create it and retry
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      await mkdir(dirname(filePath), { recursive: true });
      await appendFile(filePath, entry + "\n");
    }
    // Audit logging should never break the tool — silently ignore other errors
  }
}

async function truncateIfNeeded(filePath: string): Promise<void> {
  try {
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n").filter((line) => line.length > 0);

    if (lines.length > MAX_LOG_LINES) {
      const keptLines = lines.slice(-MAX_LOG_LINES);
      await writeFile(filePath, keptLines.join("\n") + "\n", "utf-8");
    }
  } catch {
    // Silently ignore truncation errors — log remains intact
  }
}
// test
