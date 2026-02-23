/**
 * setup/index.ts — DevClaw setup orchestrator.
 *
 * Coordinates: agent creation → plugin config → workspace scaffolding → model config.
 * Used by both the `setup` tool and the `openclaw devclaw setup` CLI command.
 */
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { PluginRuntime } from "openclaw/plugin-sdk";
import type { RunCommand } from "../context.js";
import { getAllDefaultModels } from "../roles/index.js";
import { migrateChannelBinding } from "./binding-manager.js";
import { createAgent, resolveWorkspacePath } from "./agent.js";
import { writePluginConfig } from "./config.js";
import { scaffoldWorkspace } from "./workspace.js";
import { DATA_DIR } from "./migrate-layout.js";
import type { ExecutionMode } from "../workflow/index.js";

export type ModelConfig = Record<string, Record<string, string>>;

export type SetupOpts = {
  /** OpenClaw plugin runtime for config access. */
  runtime: PluginRuntime;
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
  projectExecution?: ExecutionMode;
  /** Injected runCommand for dependency injection. */
  runCommand?: RunCommand;
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

  await writePluginConfig(opts.runtime, agentId, opts.projectExecution);

  const defaultWorkspacePath = getDefaultWorkspacePath(opts.runtime);
  const filesWritten = await scaffoldWorkspace(workspacePath, defaultWorkspacePath);

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
    if (!opts.runCommand) throw new Error("runCommand is required when creating a new agent");
    const { agentId, workspacePath } = await createAgent(opts.runtime, opts.newAgentName, opts.runCommand, opts.channelBinding);
    const bindingMigrated = await tryMigrateBinding(opts, agentId, warnings);
    return { agentId, workspacePath, agentCreated: true, bindingMigrated };
  }

  if (opts.agentId) {
    const workspacePath = opts.workspacePath ?? resolveWorkspacePath(opts.runtime, opts.agentId);
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
    await migrateChannelBinding(opts.runtime, opts.channelBinding, opts.migrateFrom, agentId);
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

function getDefaultWorkspacePath(runtime: PluginRuntime): string | undefined {
  try {
    const config = runtime.config.loadConfig();
    return (config as any).agents?.defaults?.workspace ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write model configuration to workflow.yaml (single source of truth).
 * Uses YAML Document API to preserve comments and formatting.
 */
async function writeModelsToWorkflow(workspacePath: string, models: ModelConfig): Promise<void> {
  const workflowPath = path.join(workspacePath, DATA_DIR, "workflow.yaml");

  let content = "";
  try {
    content = await fs.readFile(workflowPath, "utf-8");
  } catch { /* file doesn't exist yet */ }

  // Parse as Document to preserve comments
  const doc = content ? YAML.parseDocument(content) : new YAML.Document({});

  // Ensure roles section exists
  if (!doc.has("roles")) {
    doc.set("roles", {});
  }
  const roles = doc.getIn(["roles"], true) as unknown as YAML.YAMLMap;

  // Merge models into roles section
  for (const [role, levels] of Object.entries(models)) {
    if (!roles.has(role)) {
      roles.set(role, doc.createNode({ models: levels }));
    } else {
      const roleNode = roles.get(role, true) as unknown as YAML.YAMLMap;
      roleNode.set("models", doc.createNode(levels));
    }
  }

  await fs.writeFile(workflowPath, doc.toString({ lineWidth: 120 }), "utf-8");
}
