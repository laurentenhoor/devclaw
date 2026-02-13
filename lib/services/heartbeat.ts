/**
 * Heartbeat tick — token-free queue processing.
 *
 * Runs automatically via plugin service (periodic execution).
 *
 * Logic:
 *   1. Health pass: auto-fix zombies, stale workers, orphaned state
 *   2. Tick pass: fill free worker slots by priority
 *
 * Zero LLM tokens — all logic is deterministic code + CLI calls.
 * Workers only consume tokens when they start processing dispatched tasks.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import fs from "node:fs";
import path from "node:path";
import { readProjects } from "../projects.js";
import { log as auditLog } from "../audit.js";
import { checkWorkerHealth, fetchGatewaySessions, type SessionLookup } from "./health.js";
import { projectTick } from "./tick.js";
import { createProvider } from "../providers/index.js";
import { notifyTickPickups, getNotificationConfig } from "../notify.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HeartbeatConfig = {
  enabled: boolean;
  intervalSeconds: number;
  maxPickupsPerTick: number;
};

type Agent = {
  agentId: string;
  workspace: string;
};

type TickResult = {
  totalPickups: number;
  totalHealthFixes: number;
  totalSkipped: number;
};

type ServiceContext = {
  logger: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
  config: {
    agents?: { list?: Array<{ id: string; workspace?: string }> };
  };
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const HEARTBEAT_DEFAULTS: HeartbeatConfig = {
  enabled: true,
  intervalSeconds: 60,
  maxPickupsPerTick: 4,
};

export function resolveHeartbeatConfig(
  pluginConfig?: Record<string, unknown>,
): HeartbeatConfig {
  const raw = pluginConfig?.work_heartbeat as Partial<HeartbeatConfig> | undefined;
  return { ...HEARTBEAT_DEFAULTS, ...raw };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function registerHeartbeatService(api: OpenClawPluginApi) {
  let intervalId: ReturnType<typeof setInterval> | null = null;

  api.registerService({
    id: "devclaw-heartbeat",

    start: async (ctx: ServiceContext) => {
      const pluginConfig = api.pluginConfig as Record<string, unknown> | undefined;
      const config = resolveHeartbeatConfig(pluginConfig);

      if (!config.enabled) {
        ctx.logger.info("work_heartbeat service disabled");
        return;
      }

      const agents = discoverAgents(api.config);
      if (agents.length === 0) {
        ctx.logger.warn("work_heartbeat service: no DevClaw agents registered");
        return;
      }

      ctx.logger.info(
        `work_heartbeat service started: every ${config.intervalSeconds}s, ${agents.length} agents, max ${config.maxPickupsPerTick} pickups/tick`,
      );

      intervalId = setInterval(
        () => runHeartbeatTick(agents, config, pluginConfig, ctx.logger),
        config.intervalSeconds * 1000,
      );
    },

    stop: async (ctx) => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
        ctx.logger.info("work_heartbeat service stopped");
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Discover DevClaw agents by scanning which agent workspaces have projects.
 * Self-discovering: any agent whose workspace contains projects/projects.json is processed.
 * Also checks the default workspace (agents.defaults.workspace) for projects.
 */
function discoverAgents(config: {
  agents?: {
    list?: Array<{ id: string; workspace?: string }>;
    defaults?: { workspace?: string };
  };
}): Agent[] {
  const seen = new Set<string>();
  const agents: Agent[] = [];

  // Check explicit agent list
  for (const a of config.agents?.list || []) {
    if (!a.workspace) continue;
    try {
      if (fs.existsSync(path.join(a.workspace, "projects", "projects.json"))) {
        agents.push({ agentId: a.id, workspace: a.workspace });
        seen.add(a.workspace);
      }
    } catch { /* skip */ }
  }

  // Check default workspace (used when no explicit agents are registered)
  const defaultWorkspace = config.agents?.defaults?.workspace;
  if (defaultWorkspace && !seen.has(defaultWorkspace)) {
    try {
      if (fs.existsSync(path.join(defaultWorkspace, "projects", "projects.json"))) {
        agents.push({ agentId: "main", workspace: defaultWorkspace });
      }
    } catch { /* skip */ }
  }

  return agents;
}

/**
 * Run one heartbeat tick for all agents.
 */
async function runHeartbeatTick(
  agents: Agent[],
  config: HeartbeatConfig,
  pluginConfig: Record<string, unknown> | undefined,
  logger: ServiceContext["logger"],
): Promise<void> {
  try {
    const result = await processAllAgents(agents, config, pluginConfig, logger);
    logTickResult(result, logger);
  } catch (err) {
    logger.error(`work_heartbeat tick failed: ${err}`);
  }
}

/**
 * Process heartbeat tick for all agents and aggregate results.
 */
async function processAllAgents(
  agents: Agent[],
  config: HeartbeatConfig,
  pluginConfig: Record<string, unknown> | undefined,
  logger: ServiceContext["logger"],
): Promise<TickResult> {
  const result: TickResult = {
    totalPickups: 0,
    totalHealthFixes: 0,
    totalSkipped: 0,
  };

  // Fetch gateway sessions once for all agents/projects
  const sessions = await fetchGatewaySessions();

  for (const { agentId, workspace } of agents) {
    const agentResult = await tick({
      workspaceDir: workspace,
      agentId,
      config,
      pluginConfig,
      sessions,
      logger,
    });

    result.totalPickups += agentResult.totalPickups;
    result.totalHealthFixes += agentResult.totalHealthFixes;
    result.totalSkipped += agentResult.totalSkipped;
  }

  return result;
}

/**
 * Log tick results if anything happened.
 */
function logTickResult(result: TickResult, logger: ServiceContext["logger"]): void {
  if (result.totalPickups > 0 || result.totalHealthFixes > 0) {
    logger.info(
      `work_heartbeat tick: ${result.totalPickups} pickups, ${result.totalHealthFixes} health fixes, ${result.totalSkipped} skipped`,
    );
  }
}

// ---------------------------------------------------------------------------
// Tick (Main Heartbeat Loop)
// ---------------------------------------------------------------------------

export async function tick(opts: {
  workspaceDir: string;
  agentId?: string;
  config: HeartbeatConfig;
  pluginConfig?: Record<string, unknown>;
  sessions: SessionLookup;
  logger: { info(msg: string): void; warn(msg: string): void };
}): Promise<TickResult> {
  const { workspaceDir, agentId, config, pluginConfig, sessions } = opts;

  const data = await readProjects(workspaceDir);
  const projectIds = Object.keys(data.projects);

  if (projectIds.length === 0) {
    return { totalPickups: 0, totalHealthFixes: 0, totalSkipped: 0 };
  }

  const result: TickResult = {
    totalPickups: 0,
    totalHealthFixes: 0,
    totalSkipped: 0,
  };

  const projectExecution = (pluginConfig?.projectExecution as string) ?? "parallel";
  let activeProjects = 0;

  for (const groupId of projectIds) {
    const project = data.projects[groupId];
    if (!project) continue;

    // Health pass: auto-fix zombies and stale workers
    result.totalHealthFixes += await performHealthPass(
      workspaceDir,
      groupId,
      project,
      sessions,
    );

    // Budget check: stop if we've hit the limit
    const remaining = config.maxPickupsPerTick - result.totalPickups;
    if (remaining <= 0) break;

    // Sequential project guard: don't start new projects if one is active
    const isProjectActive = await checkProjectActive(workspaceDir, groupId);
    if (projectExecution === "sequential" && !isProjectActive && activeProjects >= 1) {
      result.totalSkipped++;
      continue;
    }

    // Tick pass: fill free worker slots
    const tickResult = await projectTick({
      workspaceDir,
      groupId,
      agentId,
      pluginConfig,
      maxPickups: remaining,
    });

    result.totalPickups += tickResult.pickups.length;
    result.totalSkipped += tickResult.skipped.length;

    // Notify project group about any pickups
    if (tickResult.pickups.length > 0) {
      const notifyConfig = getNotificationConfig(pluginConfig);
      await notifyTickPickups(tickResult.pickups, {
        workspaceDir,
        config: notifyConfig,
        channel: project.channel,
      });
    }
    if (isProjectActive || tickResult.pickups.length > 0) activeProjects++;
  }

  await auditLog(workspaceDir, "heartbeat_tick", {
    projectsScanned: projectIds.length,
    healthFixes: result.totalHealthFixes,
    pickups: result.totalPickups,
    skipped: result.totalSkipped,
  });

  return result;
}

/**
 * Run health checks and auto-fix for a project (dev + qa roles).
 */
async function performHealthPass(
  workspaceDir: string,
  groupId: string,
  project: any,
  sessions: SessionLookup,
): Promise<number> {
  const { provider } = await createProvider({ repo: project.repo });
  let fixedCount = 0;

  for (const role of ["dev", "qa"] as const) {
    const fixes = await checkWorkerHealth({
      workspaceDir,
      groupId,
      project,
      role,
      sessions,
      autoFix: true,
      provider,
    });
    fixedCount += fixes.filter((f) => f.fixed).length;
  }

  return fixedCount;
}

/**
 * Check if a project has active work (dev or qa).
 */
async function checkProjectActive(workspaceDir: string, groupId: string): Promise<boolean> {
  const fresh = (await readProjects(workspaceDir)).projects[groupId];
  if (!fresh) return false;
  return fresh.dev.active || fresh.qa.active;
}
