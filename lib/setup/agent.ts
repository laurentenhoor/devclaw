/**
 * setup/agent.ts — Agent creation and workspace resolution.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

function openclawConfigPath(): string {
  return path.join(process.env.HOME ?? "/home/lauren", ".openclaw", "openclaw.json");
}

/**
 * Create a new agent via `openclaw agents add`.
 * Cleans up .git and BOOTSTRAP.md from the workspace, updates display name.
 */
export async function createAgent(
  name: string,
  channelBinding?: "telegram" | "whatsapp" | null,
): Promise<{ agentId: string; workspacePath: string }> {
  const agentId = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  const workspacePath = path.join(
    process.env.HOME ?? "/home/lauren",
    ".openclaw",
    `workspace-${agentId}`,
  );

  const args = ["agents", "add", agentId, "--workspace", workspacePath, "--non-interactive"];
  if (channelBinding) args.push("--bind", channelBinding);

  try {
    await execFileAsync("openclaw", args, { timeout: 30_000 });
  } catch (err) {
    throw new Error(`Failed to create agent "${name}": ${(err as Error).message}`);
  }

  await cleanupWorkspace(workspacePath);
  await updateAgentDisplayName(agentId, name);

  return { agentId, workspacePath };
}

/**
 * Resolve workspace path from an agent ID by reading openclaw.json.
 */
export async function resolveWorkspacePath(agentId: string): Promise<string> {
  const raw = await fs.readFile(openclawConfigPath(), "utf-8");
  const config = JSON.parse(raw);

  const agent = config.agents?.list?.find((a: { id: string }) => a.id === agentId);
  if (!agent?.workspace) {
    throw new Error(`Agent "${agentId}" not found in openclaw.json or has no workspace configured.`);
  }

  return agent.workspace;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

async function cleanupWorkspace(workspacePath: string): Promise<void> {
  // openclaw agents add creates a .git dir and BOOTSTRAP.md — remove them
  try { await fs.rm(path.join(workspacePath, ".git"), { recursive: true }); } catch { /* may not exist */ }
  try { await fs.unlink(path.join(workspacePath, "BOOTSTRAP.md")); } catch { /* may not exist */ }
}

async function updateAgentDisplayName(agentId: string, name: string): Promise<void> {
  if (name === agentId) return;
  try {
    const configPath = openclawConfigPath();
    const config = JSON.parse(await fs.readFile(configPath, "utf-8"));
    const agent = config.agents?.list?.find((a: { id: string }) => a.id === agentId);
    if (agent) {
      agent.name = name;
      await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    }
  } catch (err) {
    console.warn(`Warning: Could not update display name: ${(err as Error).message}`);
  }
}
