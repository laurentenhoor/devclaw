/**
 * setup.ts — Shared setup logic for DevClaw onboarding.
 *
 * Used by both the `devclaw_setup` tool and the `openclaw devclaw setup` CLI command.
 * Handles: agent creation, model configuration, workspace file writes.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { ALL_TIERS, DEFAULT_MODELS, type Tier } from "./tiers.js";
import {
  AGENTS_MD_TEMPLATE,
  HEARTBEAT_MD_TEMPLATE,
  DEFAULT_DEV_INSTRUCTIONS,
  DEFAULT_QA_INSTRUCTIONS,
} from "./templates.js";
import { migrateChannelBinding } from "./binding-manager.js";

const execFileAsync = promisify(execFile);

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
  const filesWritten: string[] = [];
  let agentId: string;
  let agentCreated = false;
  let workspacePath: string;
  let bindingMigrated: SetupResult["bindingMigrated"];

  // --- Step 1: Agent ---
  if (opts.newAgentName) {
    const result = await createAgent(opts.newAgentName, opts.channelBinding);
    agentId = result.agentId;
    workspacePath = result.workspacePath;
    agentCreated = true;

    // --- Step 1b: Migration (if requested) ---
    if (opts.migrateFrom && opts.channelBinding) {
      try {
        await migrateChannelBinding(
          opts.channelBinding,
          opts.migrateFrom,
          agentId,
        );
        bindingMigrated = {
          from: opts.migrateFrom,
          channel: opts.channelBinding,
        };
      } catch (err) {
        warnings.push(
          `Failed to migrate binding from "${opts.migrateFrom}": ${(err as Error).message}`,
        );
      }
    }
  } else if (opts.agentId) {
    agentId = opts.agentId;
    workspacePath = opts.workspacePath ?? await resolveWorkspacePath(agentId);
  } else if (opts.workspacePath) {
    agentId = "unknown";
    workspacePath = opts.workspacePath;
  } else {
    throw new Error(
      "Setup requires either newAgentName, agentId, or workspacePath",
    );
  }

  // --- Step 2: Models ---
  const models = { ...DEFAULT_MODELS };
  if (opts.models) {
    for (const [tier, model] of Object.entries(opts.models)) {
      if (model && (ALL_TIERS as readonly string[]).includes(tier)) {
        models[tier as Tier] = model;
      }
    }
  }

  // Write plugin config to openclaw.json (includes agentId in devClawAgentIds)
  await writePluginConfig(models, agentId, opts.projectExecution);

  // --- Step 3: Workspace files ---

  // AGENTS.md (backup existing)
  const agentsMdPath = path.join(workspacePath, "AGENTS.md");
  await backupAndWrite(agentsMdPath, AGENTS_MD_TEMPLATE);
  filesWritten.push("AGENTS.md");

  // HEARTBEAT.md
  const heartbeatPath = path.join(workspacePath, "HEARTBEAT.md");
  await backupAndWrite(heartbeatPath, HEARTBEAT_MD_TEMPLATE);
  filesWritten.push("HEARTBEAT.md");

  // roles/default/dev.md and qa.md
  const rolesDefaultDir = path.join(workspacePath, "roles", "default");
  await fs.mkdir(rolesDefaultDir, { recursive: true });

  const devRolePath = path.join(rolesDefaultDir, "dev.md");
  const qaRolePath = path.join(rolesDefaultDir, "qa.md");

  if (!await fileExists(devRolePath)) {
    await fs.writeFile(devRolePath, DEFAULT_DEV_INSTRUCTIONS, "utf-8");
    filesWritten.push("roles/default/dev.md");
  }
  if (!await fileExists(qaRolePath)) {
    await fs.writeFile(qaRolePath, DEFAULT_QA_INSTRUCTIONS, "utf-8");
    filesWritten.push("roles/default/qa.md");
  }

  // memory/projects.json
  const memoryDir = path.join(workspacePath, "memory");
  await fs.mkdir(memoryDir, { recursive: true });
  const projectsJsonPath = path.join(memoryDir, "projects.json");
  if (!await fileExists(projectsJsonPath)) {
    await fs.writeFile(
      projectsJsonPath,
      JSON.stringify({ projects: {} }, null, 2) + "\n",
      "utf-8",
    );
    filesWritten.push("memory/projects.json");
  }

  return {
    agentId,
    agentCreated,
    workspacePath,
    models,
    filesWritten,
    warnings,
    bindingMigrated,
  };
}

/**
 * Create a new agent via `openclaw agents add`.
 */
async function createAgent(
  name: string,
  channelBinding?: "telegram" | "whatsapp" | null,
): Promise<{ agentId: string; workspacePath: string }> {
  // Generate ID from name (lowercase, hyphenated)
  const agentId = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  const workspacePath = path.join(
    process.env.HOME ?? "/home/lauren",
    ".openclaw",
    `workspace-${agentId}`,
  );

  const args = [
    "agents",
    "add",
    agentId,
    "--workspace",
    workspacePath,
    "--non-interactive",
  ];

  // Add --bind if specified
  if (channelBinding) {
    args.push("--bind", channelBinding);
  }

  try {
    await execFileAsync("openclaw", args, { timeout: 30_000 });
  } catch (err) {
    throw new Error(
      `Failed to create agent "${name}": ${(err as Error).message}`,
    );
  }

  // openclaw agents add creates a .git dir and BOOTSTRAP.md in the workspace — remove them
  const gitDir = path.join(workspacePath, ".git");
  const bootstrapFile = path.join(workspacePath, "BOOTSTRAP.md");

  try {
    await fs.rm(gitDir, { recursive: true });
  } catch {
    // May not exist — that's fine
  }

  try {
    await fs.unlink(bootstrapFile);
  } catch {
    // May not exist — that's fine
  }

  // Update agent's display name in openclaw.json if different from ID
  if (name !== agentId) {
    try {
      const configPath = path.join(
        process.env.HOME ?? "/home/lauren",
        ".openclaw",
        "openclaw.json",
      );
      const configContent = await fs.readFile(configPath, "utf-8");
      const config = JSON.parse(configContent);

      // Find the newly created agent and update its name
      const agent = config.agents?.list?.find((a: { id: string }) => a.id === agentId);
      if (agent) {
        agent.name = name;
        await fs.writeFile(
          configPath,
          JSON.stringify(config, null, 2) + "\n",
          "utf-8",
        );
      }
    } catch (err) {
      // Non-fatal - agent was created successfully, just couldn't update display name
      console.warn(`Warning: Could not update display name: ${(err as Error).message}`);
    }
  }

  return { agentId, workspacePath };
}

/**
 * Resolve workspace path from an agent ID by reading openclaw.json.
 */
async function resolveWorkspacePath(agentId: string): Promise<string> {
  const configPath = path.join(
    process.env.HOME ?? "/home/lauren",
    ".openclaw",
    "openclaw.json",
  );
  const raw = await fs.readFile(configPath, "utf-8");
  const config = JSON.parse(raw);

  const agent = config.agents?.list?.find(
    (a: { id: string }) => a.id === agentId,
  );
  if (!agent?.workspace) {
    throw new Error(
      `Agent "${agentId}" not found in openclaw.json or has no workspace configured.`,
    );
  }

  return agent.workspace;
}

/**
 * Write DevClaw model tier config and devClawAgentIds to openclaw.json plugins section.
 * Also adds tool restrictions (deny sessions_spawn, sessions_send) to DevClaw agents.
 * This prevents workers from spawning sub-agents or messaging other sessions directly.
 * Configures subagent cleanup interval to keep development sessions alive.
 * Read-modify-write to preserve existing config.
 */
async function writePluginConfig(
  models: Record<Tier, string>,
  agentId?: string,
  projectExecution?: "parallel" | "sequential",
): Promise<void> {
  const configPath = path.join(
    process.env.HOME ?? "/home/lauren",
    ".openclaw",
    "openclaw.json",
  );
  const raw = await fs.readFile(configPath, "utf-8");
  const config = JSON.parse(raw);

  // Ensure plugins.entries.devclaw.config exists
  if (!config.plugins) config.plugins = {};
  if (!config.plugins.entries) config.plugins.entries = {};
  if (!config.plugins.entries.devclaw) config.plugins.entries.devclaw = {};
  if (!config.plugins.entries.devclaw.config)
    config.plugins.entries.devclaw.config = {};

  // Write models
  config.plugins.entries.devclaw.config.models = { ...models };

  // Write projectExecution if specified
  if (projectExecution) {
    config.plugins.entries.devclaw.config.projectExecution = projectExecution;
  }

  // Configure subagent cleanup interval to 30 days (43200 minutes)
  // This keeps development sessions alive during active development
  if (!config.agents) config.agents = {};
  if (!config.agents.defaults) config.agents.defaults = {};
  if (!config.agents.defaults.subagents) config.agents.defaults.subagents = {};
  config.agents.defaults.subagents.archiveAfterMinutes = 43200;

  // Write/update devClawAgentIds
  if (agentId) {
    const existing = config.plugins.entries.devclaw.config.devClawAgentIds ?? [];
    if (!existing.includes(agentId)) {
      config.plugins.entries.devclaw.config.devClawAgentIds = [...existing, agentId];
    }

    // Add tool restrictions to the agent
    // Workers shouldn't spawn sub-agents or message other sessions directly
    // All coordination should go through DevClaw tools (task_pickup, task_complete, etc.)
    const agent = config.agents?.list?.find((a: { id: string }) => a.id === agentId);
    if (agent) {
      if (!agent.tools) {
        agent.tools = {};
      }
      agent.tools.deny = ["sessions_spawn", "sessions_send"];
      // Clear any conflicting allow list
      delete agent.tools.allow;
    }
  }

  // Atomic write
  const tmpPath = configPath + ".tmp";
  await fs.writeFile(tmpPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  await fs.rename(tmpPath, configPath);
}

/**
 * Backup existing file (if any) and write new content.
 */
async function backupAndWrite(
  filePath: string,
  content: string,
): Promise<void> {
  try {
    await fs.access(filePath);
    // File exists — backup
    const bakPath = filePath + ".bak";
    await fs.copyFile(filePath, bakPath);
  } catch {
    // File doesn't exist — ensure directory
    await fs.mkdir(path.dirname(filePath), { recursive: true });
  }
  await fs.writeFile(filePath, content, "utf-8");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
