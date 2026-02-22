/**
 * setup/config.ts — Plugin config writer (openclaw.json).
 *
 * Handles: tool restrictions for orchestrator and worker agents, heartbeat defaults.
 * Models are stored in workflow.yaml (not openclaw.json).
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { HEARTBEAT_DEFAULTS } from "../services/heartbeat.js";
import type { ExecutionMode } from "../workflow.js";

/**
 * Write DevClaw plugin config to openclaw.json plugins section.
 *
 * Configures:
 * - Tool restrictions (deny sessions_spawn, sessions_send) for orchestrator agent
 * - Tool restrictions (deny orchestrator-only tools) for worker agent
 * - Heartbeat defaults
 *
 * Read-modify-write to preserve existing config.
 * Note: models are NOT stored here — they live in workflow.yaml.
 */
export async function writePluginConfig(
  api: OpenClawPluginApi,
  agentId?: string,
  workerAgentId?: string,
  projectExecution?: ExecutionMode,
): Promise<void> {
  const config = api.runtime.config.loadConfig() as Record<string, unknown>;

  ensurePluginStructure(config);

  if (projectExecution) {
    (config as any).plugins.entries.devclaw.config.projectExecution = projectExecution;
  }

  // Clean up legacy models from openclaw.json (moved to workflow.yaml)
  delete (config as any).plugins.entries.devclaw.config.models;

  ensureInternalHooks(config);
  ensureHeartbeatDefaults(config);
  ensureTelegramLinkPreviewDisabled(config);

  if (agentId) {
    addToolRestrictions(config, agentId);
  }
  if (workerAgentId) {
    addWorkerToolRestrictions(config, workerAgentId);
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

function addToolRestrictions(config: Record<string, unknown>, agentId: string): void {
  const agent = (config as any).agents?.list?.find((a: { id: string }) => a.id === agentId);
  if (agent) {
    if (!agent.tools) agent.tools = {};
    agent.tools.deny = ["sessions_spawn", "sessions_send"];
    delete agent.tools.allow;
  }
}

function ensureInternalHooks(config: Record<string, unknown>): void {
  if (!config.hooks) config.hooks = {};
  const hooks = config.hooks as Record<string, unknown>;
  if (!hooks.internal) hooks.internal = {};
  (hooks.internal as Record<string, unknown>).enabled = true;
}

function ensureHeartbeatDefaults(config: Record<string, unknown>): void {
  const devclaw = (config as any).plugins.entries.devclaw.config;
  if (!devclaw.work_heartbeat) {
    devclaw.work_heartbeat = { ...HEARTBEAT_DEFAULTS };
  }
}

/**
 * Deny orchestrator-only tools on the worker agent.
 * Workers should only use work_finish, task_create, and standard dev tools.
 */
function addWorkerToolRestrictions(config: Record<string, unknown>, workerAgentId: string): void {
  const agent = (config as any).agents?.list?.find((a: { id: string }) => a.id === workerAgentId);
  if (agent) {
    if (!agent.tools) agent.tools = {};
    agent.tools.deny = [
      "sessions_spawn",
      "sessions_send",
      "work_start",
      "tasks_status",
      "health",
      "project_register",
      "setup",
    ];
    delete agent.tools.allow;
  }
}

/**
 * Disable Telegram link previews so notifications don't show URL preview cards.
 * Sets channels.telegram.linkPreview = false if the Telegram channel is configured.
 * Only sets if not already explicitly configured (respects user overrides).
 */
function ensureTelegramLinkPreviewDisabled(config: Record<string, unknown>): void {
  const channels = config.channels as Record<string, unknown> | undefined;
  if (!channels) return;
  const telegram = channels.telegram as Record<string, unknown> | undefined;
  if (!telegram) return;
  if (telegram.linkPreview === undefined) {
    telegram.linkPreview = false;
  }
}
