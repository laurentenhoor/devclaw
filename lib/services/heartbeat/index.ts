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
import type { OpenClawPluginApi, PluginRuntime } from "openclaw/plugin-sdk";
import type { PluginContext } from "../../context.js";
import { ensureDefaultFiles } from "../../setup/workspace.js";
import {
  fetchGatewaySessions,
} from "./health.js";
import type { Agent } from "./agent-discovery.js";
import { discoverAgents } from "./agent-discovery.js";
import { HEARTBEAT_DEFAULTS, resolveHeartbeatConfig } from "./config.js";
import type { HeartbeatConfig } from "./config.js";

export { HEARTBEAT_DEFAULTS };
import { tick } from "./tick-runner.js";
import type { TickResult } from "./tick-runner.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ServiceContext = {
  logger: {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
  };
  config: {
    agents?: { list?: Array<{ id: string; workspace?: string }> };
  };
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function registerHeartbeatService(api: OpenClawPluginApi, pluginCtx: PluginContext) {
  let intervalId: ReturnType<typeof setInterval> | null = null;

  api.registerService({
    id: "devclaw-heartbeat",

    start: async (svcCtx: ServiceContext) => {
      const { intervalSeconds } = HEARTBEAT_DEFAULTS;

      // Config + agent discovery happen per-tick so the heartbeat automatically
      // picks up projects onboarded after the gateway starts — no restart needed.
      intervalId = setInterval(
        () => runHeartbeatTick(pluginCtx, svcCtx.logger),
        intervalSeconds * 1000,
      );

      // Run an immediate tick shortly after startup so queued work is picked up
      // right away instead of waiting for the full interval (up to 60s).
      // The 2s delay lets the plugin and providers fully initialize first.
      setTimeout(() => runHeartbeatTick(pluginCtx, svcCtx.logger), 2_000);
    },

    stop: async (svcCtx) => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
        svcCtx.logger.info("work_heartbeat service stopped");
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Tick orchestration
// ---------------------------------------------------------------------------

/**
 * Run one heartbeat tick for all agents.
 * Re-reads config and re-discovers agents each tick so projects onboarded
 * after the gateway starts are picked up automatically — no restart needed.
 */
async function runHeartbeatTick(
  ctx: PluginContext,
  logger: ServiceContext["logger"],
): Promise<void> {
  try {
    const config = resolveHeartbeatConfig(ctx.pluginConfig);
    if (!config.enabled) return;

    const agents = discoverAgents(ctx.config);
    if (agents.length === 0) return;

    const result = await processAllAgents(agents, config, ctx.pluginConfig, logger, ctx.runCommand, ctx.runtime);
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
  runCommand: import("../../context.js").RunCommand,
  runtime?: PluginRuntime,
): Promise<TickResult> {
  const result: TickResult = {
    totalPickups: 0,
    totalHealthFixes: 0,
    totalSkipped: 0,
    totalReviewTransitions: 0,
    totalReviewSkipTransitions: 0,
    totalTestSkipTransitions: 0,
  };

  // Ensure defaults are fresh on every startup (prompts, workflow, etc.)
  const refreshedWorkspaces = new Set<string>();
  for (const { workspace } of agents) {
    if (refreshedWorkspaces.has(workspace)) continue;
    refreshedWorkspaces.add(workspace);
    try {
      await ensureDefaultFiles(workspace);
    } catch (err) {
      logger.warn(`Workspace refresh failed for ${workspace}: ${(err as Error).message}`);
    }
  }

  // Fetch gateway sessions once for all agents/projects
  const sessions = await fetchGatewaySessions(undefined, runCommand);

  for (const { agentId, workspace } of agents) {
    const agentResult = await tick({
      workspaceDir: workspace,
      agentId,
      config,
      pluginConfig,
      sessions,
      logger,
      runtime,
      runCommand,
    });

    result.totalPickups += agentResult.totalPickups;
    result.totalHealthFixes += agentResult.totalHealthFixes;
    result.totalSkipped += agentResult.totalSkipped;
    result.totalReviewTransitions += agentResult.totalReviewTransitions;
    result.totalReviewSkipTransitions += agentResult.totalReviewSkipTransitions;
    result.totalTestSkipTransitions += agentResult.totalTestSkipTransitions;
  }

  return result;
}

/**
 * Log tick results if anything happened.
 */
function logTickResult(
  result: TickResult,
  logger: ServiceContext["logger"],
): void {
  if (
    result.totalPickups > 0 ||
    result.totalHealthFixes > 0 ||
    result.totalReviewTransitions > 0 ||
    result.totalReviewSkipTransitions > 0 ||
    result.totalTestSkipTransitions > 0
  ) {
    logger.info(
      `work_heartbeat tick: ${result.totalPickups} pickups, ${result.totalHealthFixes} health fixes, ${result.totalReviewTransitions} review transitions, ${result.totalReviewSkipTransitions} review skips, ${result.totalTestSkipTransitions} test skips, ${result.totalSkipped} skipped`,
    );
  }
}

