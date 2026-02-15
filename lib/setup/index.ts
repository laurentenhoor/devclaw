/**
 * setup/index.ts — DevClaw setup orchestrator.
 *
 * Coordinates: agent creation → model config → workspace scaffolding.
 * Used by both the `setup` tool and the `openclaw devclaw setup` CLI command.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { DEFAULT_MODELS } from "../tiers.js";
import { migrateChannelBinding } from "../binding-manager.js";
import { createAgent, resolveWorkspacePath } from "./agent.js";
import { writePluginConfig } from "./config.js";
import { scaffoldWorkspace } from "./workspace.js";

export type ModelConfig = { dev: Record<string, string>; qa: Record<string, string>; architect: Record<string, string> };

export type SetupOpts = {
  /** OpenClaw plugin API for config access. */
  api: OpenClawPluginApi;
  /** Create a new agent with this name. Mutually exclusive with agentId. */
  newAgentName?: string;
  /** Channel binding for new agent. Only used when newAgentName is set. */
  channelBinding?: "telegram" | "whatsapp" | null;
  /** Migrate channel binding from this agent ID. Only used when newAgentName and channelBinding are set. */
  migrateFrom?: string;
  /** Use an existing agent by ID. Mutually exclusive with newAgentName. */
  agentId?: string;
  /** Override workspace path (auto-detected from agent if not given). */
  workspacePath?: string;
  /** Model overrides per role.level. Missing levels use defaults. */
  models?: { dev?: Partial<Record<string, string>>; qa?: Partial<Record<string, string>>; architect?: Partial<Record<string, string>> };
  /** Plugin-level project execution mode: parallel or sequential. Default: parallel. */
  projectExecution?: "parallel" | "sequential";
};

export type SetupResult = {
  agentId: string;
  agentCreated: boolean;
  workspacePath: string;
  models: ModelConfig;
  filesWritten: string[];
  warnings: string[];
  bindingMigrated?: {
    from: string;
    channel: "telegram" | "whatsapp";
  };
};

/**
 * Run the full DevClaw setup.
 *
 * 1. Create agent (optional) or resolve existing workspace
 * 2. Merge model config and write to openclaw.json
 * 3. Write workspace files (AGENTS.md, HEARTBEAT.md, roles, memory)
 */
export async function runSetup(opts: SetupOpts): Promise<SetupResult> {
  const warnings: string[] = [];

  const { agentId, workspacePath, agentCreated, bindingMigrated } =
    await resolveOrCreateAgent(opts, warnings);

  const models = buildModelConfig(opts.models);
  await writePluginConfig(opts.api, models, agentId, opts.projectExecution);

  const filesWritten = await scaffoldWorkspace(workspacePath);

  return { agentId, agentCreated, workspacePath, models, filesWritten, warnings, bindingMigrated };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

async function resolveOrCreateAgent(
  opts: SetupOpts,
  warnings: string[],
): Promise<{
  agentId: string;
  workspacePath: string;
  agentCreated: boolean;
  bindingMigrated?: SetupResult["bindingMigrated"];
}> {
  if (opts.newAgentName) {
    const { agentId, workspacePath } = await createAgent(opts.api, opts.newAgentName, opts.channelBinding);
    const bindingMigrated = await tryMigrateBinding(opts, agentId, warnings);
    return { agentId, workspacePath, agentCreated: true, bindingMigrated };
  }

  if (opts.agentId) {
    const workspacePath = opts.workspacePath ?? resolveWorkspacePath(opts.api, opts.agentId);
    return { agentId: opts.agentId, workspacePath, agentCreated: false };
  }

  if (opts.workspacePath) {
    return { agentId: "unknown", workspacePath: opts.workspacePath, agentCreated: false };
  }

  throw new Error("Setup requires either newAgentName, agentId, or workspacePath");
}

async function tryMigrateBinding(
  opts: SetupOpts,
  agentId: string,
  warnings: string[],
): Promise<SetupResult["bindingMigrated"]> {
  if (!opts.migrateFrom || !opts.channelBinding) return undefined;
  try {
    await migrateChannelBinding(opts.api, opts.channelBinding, opts.migrateFrom, agentId);
    return { from: opts.migrateFrom, channel: opts.channelBinding };
  } catch (err) {
    warnings.push(`Failed to migrate binding from "${opts.migrateFrom}": ${(err as Error).message}`);
    return undefined;
  }
}

function buildModelConfig(overrides?: SetupOpts["models"]): ModelConfig {
  const dev: Record<string, string> = { ...DEFAULT_MODELS.dev };
  const qa: Record<string, string> = { ...DEFAULT_MODELS.qa };
  const architect: Record<string, string> = { ...DEFAULT_MODELS.architect };

  if (overrides?.dev) {
    for (const [level, model] of Object.entries(overrides.dev)) {
      if (model) dev[level] = model;
    }
  }
  if (overrides?.qa) {
    for (const [level, model] of Object.entries(overrides.qa)) {
      if (model) qa[level] = model;
    }
  }
  if (overrides?.architect) {
    for (const [level, model] of Object.entries(overrides.architect)) {
      if (model) architect[level] = model;
    }
  }

  return { dev, qa, architect };
}
