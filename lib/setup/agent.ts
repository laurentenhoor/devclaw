/**
 * setup/agent.ts — Agent creation and workspace resolution.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { runCommand } from "../run-command.js";

/**
 * Create a new agent via `openclaw agents add`.
 * Cleans up .git and BOOTSTRAP.md from the workspace, updates display name.
 */
export async function createAgent(
  api: OpenClawPluginApi,
  name: string,
  channelBinding?: "telegram" | "whatsapp" | null,
): Promise<{ agentId: string; workspacePath: string }> {
  const agentId = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  const args = ["agents", "add", agentId, "--non-interactive"];
  if (channelBinding) args.push("--bind", channelBinding);

  try {
    await runCommand(["openclaw", ...args], { timeoutMs: 30_000 });
  } catch (err) {
    throw new Error(`Failed to create agent "${name}": ${(err as Error).message}`);
  }

  const workspacePath = resolveWorkspacePath(api, agentId);
  await cleanupWorkspace(workspacePath);
  await updateAgentDisplayName(api, agentId, name);

  return { agentId, workspacePath };
}

/**
 * Resolve workspace path from an agent ID via OpenClaw config API.
 */
export function resolveWorkspacePath(api: OpenClawPluginApi, agentId: string): string {
  const config = api.runtime.config.loadConfig();
  const agent = config.agents?.list?.find((a) => a.id === agentId);
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

async function updateAgentDisplayName(api: OpenClawPluginApi, agentId: string, name: string): Promise<void> {
  if (name === agentId) return;
  try {
    const config = api.runtime.config.loadConfig();
    const agent = config.agents?.list?.find((a) => a.id === agentId);
    if (agent) {
      (agent as any).name = name;
      await api.runtime.config.writeConfigFile(config);
    }
  } catch (err) {
    console.warn(`Warning: Could not update display name: ${(err as Error).message}`);
  }
}
