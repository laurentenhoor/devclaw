/**
 * setup/index.ts — DevClaw setup orchestrator.
 *
 * Coordinates: agent creation → plugin config → workspace scaffolding → model config.
 * Used by both the `setup` tool and the `openclaw devclaw setup` CLI command.
 */
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { getAllDefaultModels } from "../roles/index.js";
import { migrateChannelBinding } from "../binding-manager.js";
import { createAgent, resolveWorkspacePath } from "./agent.js";
import { writePluginConfig } from "./config.js";
import { scaffoldWorkspace } from "./workspace.js";
import { DATA_DIR } from "./migrate-layout.js";

export type ModelConfig = Record<string, Record<string, string>>;

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
  models?: Record<string, Partial<Record<string, string>>>;
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
 * 2. Write plugin config to openclaw.json (heartbeat, tool restrictions — no models)
 * 3. Write workspace files (AGENTS.md, HEARTBEAT.md, workflow.yaml, prompts)
 * 4. Write model config to workflow.yaml (single source of truth)
 */
export async function runSetup(opts: SetupOpts): Promise<SetupResult> {
  const warnings: string[] = [];

  const { agentId, workspacePath, agentCreated, bindingMigrated } =
    await resolveOrCreateAgent(opts, warnings);

  await writePluginConfig(opts.api, agentId, opts.projectExecution);

  const filesWritten = await scaffoldWorkspace(workspacePath);

  const models = buildModelConfig(opts.models);
  await writeModelsToWorkflow(workspacePath, models);

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
  const defaults = getAllDefaultModels();
  const result: ModelConfig = {};

  for (const [role, levels] of Object.entries(defaults)) {
    result[role] = { ...levels };
  }

  if (overrides) {
    for (const [role, roleOverrides] of Object.entries(overrides)) {
      if (!result[role]) result[role] = {};
      for (const [level, model] of Object.entries(roleOverrides)) {
        if (model) result[role][level] = model;
      }
    }
  }

  return result;
}

/**
 * Write model configuration to workflow.yaml (single source of truth).
 * Reads the existing workflow.yaml, merges model overrides into the roles section, and writes back.
 */
async function writeModelsToWorkflow(workspacePath: string, models: ModelConfig): Promise<void> {
  const workflowPath = path.join(workspacePath, DATA_DIR, "workflow.yaml");

  let doc: Record<string, unknown> = {};
  try {
    const content = await fs.readFile(workflowPath, "utf-8");
    doc = (YAML.parse(content) as Record<string, unknown>) ?? {};
  } catch { /* file doesn't exist yet — start fresh */ }

  // Merge models into roles section
  if (!doc.roles) doc.roles = {};
  const roles = doc.roles as Record<string, unknown>;

  for (const [role, levels] of Object.entries(models)) {
    if (!roles[role] || roles[role] === false) {
      roles[role] = { models: levels };
    } else {
      const roleObj = roles[role] as Record<string, unknown>;
      roleObj.models = levels;
    }
  }

  await fs.writeFile(workflowPath, YAML.stringify(doc, { lineWidth: 120 }), "utf-8");
}
