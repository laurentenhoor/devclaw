/**
 * setup/index.ts — DevClaw setup orchestrator.
 *
 * Coordinates: agent creation → model config → workspace scaffolding.
 * Used by both the `setup` tool and the `openclaw devclaw setup` CLI command.
 */
import { ALL_TIERS, DEFAULT_MODELS, type Tier } from "../tiers.js";
import { migrateChannelBinding } from "../binding-manager.js";
import { createAgent, resolveWorkspacePath } from "./agent.js";
import { writePluginConfig } from "./config.js";
import { scaffoldWorkspace } from "./workspace.js";

export type SetupOpts = {
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
  /** Model overrides per tier. Missing tiers use defaults. */
  models?: Partial<Record<Tier, string>>;
  /** Plugin-level project execution mode: parallel or sequential. Default: parallel. */
  projectExecution?: "parallel" | "sequential";
};

export type SetupResult = {
  agentId: string;
  agentCreated: boolean;
  workspacePath: string;
  models: Record<Tier, string>;
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
  await writePluginConfig(models, agentId, opts.projectExecution);

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
    const { agentId, workspacePath } = await createAgent(opts.newAgentName, opts.channelBinding);
    const bindingMigrated = await tryMigrateBinding(opts, agentId, warnings);
    return { agentId, workspacePath, agentCreated: true, bindingMigrated };
  }

  if (opts.agentId) {
    const workspacePath = opts.workspacePath ?? await resolveWorkspacePath(opts.agentId);
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
    await migrateChannelBinding(opts.channelBinding, opts.migrateFrom, agentId);
    return { from: opts.migrateFrom, channel: opts.channelBinding };
  } catch (err) {
    warnings.push(`Failed to migrate binding from "${opts.migrateFrom}": ${(err as Error).message}`);
    return undefined;
  }
}

function buildModelConfig(overrides?: Partial<Record<Tier, string>>): Record<Tier, string> {
  const models = { ...DEFAULT_MODELS };
  if (overrides) {
    for (const [tier, model] of Object.entries(overrides)) {
      if (model && (ALL_TIERS as readonly string[]).includes(tier)) {
        models[tier as Tier] = model;
      }
    }
  }
  return models;
}
