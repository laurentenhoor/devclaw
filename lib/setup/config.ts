/**
 * setup/config.ts — Plugin config writer (openclaw.json).
 *
 * Handles: model level config, tool restrictions, subagent cleanup.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { HEARTBEAT_DEFAULTS } from "../services/heartbeat.js";

type ModelConfig = { dev: Record<string, string>; qa: Record<string, string>; architect: Record<string, string> };

/**
 * Write DevClaw model level config to openclaw.json plugins section.
 *
 * Also configures:
 * - Tool restrictions (deny sessions_spawn, sessions_send) for DevClaw agents
 * - Subagent cleanup interval (30 days) to keep development sessions alive
 *
 * Read-modify-write to preserve existing config.
 */
export async function writePluginConfig(
  api: OpenClawPluginApi,
  models: ModelConfig,
  agentId?: string,
  projectExecution?: "parallel" | "sequential",
): Promise<void> {
  const config = api.runtime.config.loadConfig() as Record<string, unknown>;

  ensurePluginStructure(config);
  (config as any).plugins.entries.devclaw.config.models = models;

  if (projectExecution) {
    (config as any).plugins.entries.devclaw.config.projectExecution = projectExecution;
  }

  ensureHeartbeatDefaults(config);
  configureSubagentCleanup(config);

  if (agentId) {
    addToolRestrictions(config, agentId);
  }

  await api.runtime.config.writeConfigFile(config as any);
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
