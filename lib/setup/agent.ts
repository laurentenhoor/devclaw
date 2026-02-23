/**
 * setup/agent.ts — Agent creation and workspace resolution.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginApi, PluginRuntime } from "openclaw/plugin-sdk";
import type { RunCommand } from "../context.js";

/**
 * Create a new agent via `openclaw agents add`.
 * Cleans up .git and BOOTSTRAP.md from the workspace, updates display name.
 */
export async function createAgent(
  api: OpenClawPluginApi | PluginRuntime,
  name: string,
  runCommand: RunCommand,
  channelBinding?: "telegram" | "whatsapp" | null,
): Promise<{ agentId: string; workspacePath: string }> {
  const rc = runCommand;
  const agentId = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  const args = ["agents", "add", agentId, "--non-interactive"];
  if (channelBinding) args.push("--bind", channelBinding);

  try {
    await rc(["openclaw", ...args], { timeoutMs: 30_000 });
  } catch (err) {
    throw new Error(`Failed to create agent "${name}": ${(err as Error).message}`);
  }

  const runtime = "runtime" in api ? api.runtime : api;
  const workspacePath = resolveWorkspacePath(runtime, agentId);
  await cleanupWorkspace(workspacePath);
  await updateAgentDisplayName(runtime, agentId, name);

  return { agentId, workspacePath };
}

/**
 * Resolve workspace path from an agent ID via OpenClaw config API.
 */
export function resolveWorkspacePath(api: OpenClawPluginApi | PluginRuntime, agentId: string): string {
  const runtime = "runtime" in api ? api.runtime : api;
  const config = runtime.config.loadConfig();
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

async function updateAgentDisplayName(runtime: PluginRuntime, agentId: string, name: string): Promise<void> {
  if (name === agentId) return;
  try {
    const config = runtime.config.loadConfig();
    const agent = config.agents?.list?.find((a) => a.id === agentId);
    if (agent) {
      (agent as any).name = name;
      await runtime.config.writeConfigFile(config);
    }
  } catch (err) {
    console.warn(`Warning: Could not update display name: ${(err as Error).message}`);
  }
}
