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
import { scaffoldWorkspace, scaffoldWorkerWorkspace } from "./workspace.js";
import { resolveWorkerAgentId } from "../dispatch.js";
import { DATA_DIR } from "./migrate-layout.js";
import type { ExecutionMode } from "../workflow.js";

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
  projectExecution?: ExecutionMode;
};

export type SetupResult = {
  agentId: string;
  agentCreated: boolean;
  workspacePath: string;
  workerAgentId: string;
  workerAgentCreated: boolean;
  workerWorkspacePath: string;
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
 * 1. Create orchestrator agent (optional) or resolve existing workspace
 * 2. Create worker agent (if it doesn't exist)
 * 3. Write plugin config to openclaw.json (heartbeat, tool restrictions — no models)
 * 4. Write workspace files (AGENTS.md, HEARTBEAT.md, workflow.yaml, prompts)
 * 5. Write model config to workflow.yaml (single source of truth)
 */
export async function runSetup(opts: SetupOpts): Promise<SetupResult> {
  const warnings: string[] = [];

  const { agentId, workspacePath, agentCreated, bindingMigrated } =
    await resolveOrCreateAgent(opts, warnings);

  // Create or resolve the worker agent
  const workerAgentId = resolveWorkerAgentId(agentId);
  const { workerAgentCreated, workerWorkspacePath } =
    await ensureWorkerAgent(opts.api, workerAgentId, warnings);

  await writePluginConfig(opts.api, agentId, workerAgentId, opts.projectExecution);

  const defaultWorkspacePath = getDefaultWorkspacePath(opts.api);
  const filesWritten = await scaffoldWorkspace(workspacePath, defaultWorkspacePath);

  // Scaffold worker workspace (standalone AGENTS.md, no data files)
  const workerFiles = await scaffoldWorkerWorkspace(workerWorkspacePath);
  filesWritten.push(...workerFiles.map((f) => `worker:${f}`));

  const models = buildModelConfig(opts.models);
  await writeModelsToWorkflow(workspacePath, models);

  return {
    agentId, agentCreated, workspacePath,
    workerAgentId, workerAgentCreated, workerWorkspacePath,
    models, filesWritten, warnings, bindingMigrated,
  };
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

/**
 * Create the worker agent if it doesn't already exist.
 * Worker agents are independent agents (not subagents) used for all DevClaw worker roles.
 */
async function ensureWorkerAgent(
  api: OpenClawPluginApi,
  workerAgentId: string,
  warnings: string[],
): Promise<{ workerAgentCreated: boolean; workerWorkspacePath: string }> {
  // Check if worker agent already exists
  try {
    const workspacePath = resolveWorkspacePath(api, workerAgentId);
    return { workerAgentCreated: false, workerWorkspacePath: workspacePath };
  } catch {
    // Agent doesn't exist — create it
  }

  try {
    const { workspacePath } = await createAgent(api, workerAgentId);
    return { workerAgentCreated: true, workerWorkspacePath: workspacePath };
  } catch (err) {
    warnings.push(`Failed to create worker agent "${workerAgentId}": ${(err as Error).message}`);
    // Fall back to a conventional path so scaffolding can still proceed
    const config = api.runtime.config.loadConfig();
    const defaultWorkspace = (config as any).agents?.defaults?.workspace;
    const fallbackPath = defaultWorkspace
      ? path.join(path.dirname(defaultWorkspace), workerAgentId)
      : path.join(process.env.HOME ?? "/tmp", ".openclaw", "workspace", workerAgentId);
    return { workerAgentCreated: false, workerWorkspacePath: fallbackPath };
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

function getDefaultWorkspacePath(api: OpenClawPluginApi): string | undefined {
  try {
    const config = api.runtime.config.loadConfig();
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
