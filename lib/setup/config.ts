/**
 * setup/config.ts — Plugin config writer (openclaw.json).
 *
 * Handles: model tier config, devClawAgentIds, tool restrictions, subagent cleanup.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { DEV_TIERS, QA_TIERS, type Tier } from "../tiers.js";
import { HEARTBEAT_DEFAULTS } from "../services/heartbeat.js";

function openclawConfigPath(): string {
  return path.join(process.env.HOME ?? "/home/lauren", ".openclaw", "openclaw.json");
}

/**
 * Convert flat tier map to nested role-tier structure.
 */
function buildRoleTierModels(models: Record<Tier, string>): { dev: Record<string, string>; qa: Record<string, string> } {
  const dev: Record<string, string> = {};
  const qa: Record<string, string> = {};

  for (const tier of DEV_TIERS) {
    dev[tier] = models[tier];
  }
  for (const tier of QA_TIERS) {
    qa[tier] = models[tier];
  }

  return { dev, qa };
}

/**
 * Write DevClaw model tier config and devClawAgentIds to openclaw.json plugins section.
 *
 * Also configures:
 * - Tool restrictions (deny sessions_spawn, sessions_send) for DevClaw agents
 * - Subagent cleanup interval (30 days) to keep development sessions alive
 *
 * Read-modify-write to preserve existing config.
 */
export async function writePluginConfig(
  models: Record<Tier, string>,
  agentId?: string,
  projectExecution?: "parallel" | "sequential",
): Promise<void> {
  const configPath = openclawConfigPath();
  const config = JSON.parse(await fs.readFile(configPath, "utf-8"));

  ensurePluginStructure(config);
  config.plugins.entries.devclaw.config.models = buildRoleTierModels(models);

  if (projectExecution) {
    config.plugins.entries.devclaw.config.projectExecution = projectExecution;
  }

  ensureHeartbeatDefaults(config);
  configureSubagentCleanup(config);

  if (agentId) {
    addDevClawAgentId(config, agentId);
    addToolRestrictions(config, agentId);
  }

  const tmpPath = configPath + ".tmp";
  await fs.writeFile(tmpPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  await fs.rename(tmpPath, configPath);
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function ensurePluginStructure(config: Record<string, unknown>): void {
  if (!config.plugins) config.plugins = {};
  const plugins = config.plugins as Record<string, unknown>;
  if (!plugins.entries) plugins.entries = {};
  const entries = plugins.entries as Record<string, unknown>;
  if (!entries.devclaw) entries.devclaw = {};
  const devclaw = entries.devclaw as Record<string, unknown>;
  if (!devclaw.config) devclaw.config = {};
}

function configureSubagentCleanup(config: Record<string, unknown>): void {
  if (!config.agents) config.agents = {};
  const agents = config.agents as Record<string, unknown>;
  if (!agents.defaults) agents.defaults = {};
  const defaults = agents.defaults as Record<string, unknown>;
  if (!defaults.subagents) defaults.subagents = {};
  (defaults.subagents as Record<string, unknown>).archiveAfterMinutes = 43200;
}

function addDevClawAgentId(config: Record<string, unknown>, agentId: string): void {
  const devclaw = (config as any).plugins.entries.devclaw.config;
  const existing: string[] = devclaw.devClawAgentIds ?? [];
  if (!existing.includes(agentId)) {
    devclaw.devClawAgentIds = [...existing, agentId];
  }
}

function addToolRestrictions(config: Record<string, unknown>, agentId: string): void {
  const agent = (config as any).agents?.list?.find((a: { id: string }) => a.id === agentId);
  if (agent) {
    if (!agent.tools) agent.tools = {};
    agent.tools.deny = ["sessions_spawn", "sessions_send"];
    delete agent.tools.allow;
  }
}

function ensureHeartbeatDefaults(config: Record<string, unknown>): void {
  const devclaw = (config as any).plugins.entries.devclaw.config;
  if (!devclaw.work_heartbeat) {
    devclaw.work_heartbeat = { ...HEARTBEAT_DEFAULTS };
  }
}
