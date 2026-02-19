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
import { readProjects, getProject } from "../projects.js";
import { log as auditLog } from "../audit.js";
import { DATA_DIR } from "../setup/migrate-layout.js";
import {
  checkWorkerHealth,
  scanOrphanedLabels,
  scanOrphanedSessions,
  fetchGatewaySessions,
  type SessionLookup,
} from "./health.js";
import { projectTick } from "./tick.js";
import { reviewPass } from "./review.js";
import { createProvider } from "../providers/index.js";
import { loadConfig } from "../config/index.js";
import { ExecutionMode, resolveNotifyChannel } from "../workflow.js";
import { notify, getNotificationConfig } from "../notify.js";

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
  totalReviewTransitions: number;
};

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
  const raw = pluginConfig?.work_heartbeat as
    | Partial<HeartbeatConfig>
    | undefined;
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
      const { intervalSeconds } = HEARTBEAT_DEFAULTS;

      // Config + agent discovery happen per-tick so the heartbeat automatically
      // picks up projects onboarded after the gateway starts — no restart needed.
      intervalId = setInterval(
        () => runHeartbeatTick(api, ctx.logger),
        intervalSeconds * 1000,
      );

      // Run an immediate tick shortly after startup so queued work is picked up
      // right away instead of waiting for the full interval (up to 60s).
      // The 2s delay lets the plugin and providers fully initialize first.
      setTimeout(() => runHeartbeatTick(api, ctx.logger), 2_000);
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
 * Self-discovering: any agent whose workspace contains projects.json is processed.
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
      if (hasProjects(a.workspace)) {
        agents.push({ agentId: a.id, workspace: a.workspace });
        seen.add(a.workspace);
      }
    } catch {
      /* skip */
    }
  }

  // Check default workspace (used when no explicit agents are registered)
  const defaultWorkspace = config.agents?.defaults?.workspace;
  if (defaultWorkspace && !seen.has(defaultWorkspace)) {
    try {
      if (hasProjects(defaultWorkspace)) {
        agents.push({ agentId: "main", workspace: defaultWorkspace });
      }
    } catch {
      /* skip */
    }
  }

  return agents;
}

/** Check if a workspace has a projects.json (new or old locations). */
function hasProjects(workspace: string): boolean {
  return (
    fs.existsSync(path.join(workspace, DATA_DIR, "projects.json")) ||
    fs.existsSync(path.join(workspace, "projects.json")) ||
    fs.existsSync(path.join(workspace, "projects", "projects.json"))
  );
}

/**
 * Run one heartbeat tick for all agents.
 * Re-reads config and re-discovers agents each tick so projects onboarded
 * after the gateway starts are picked up automatically — no restart needed.
 */
async function runHeartbeatTick(
  api: OpenClawPluginApi,
  logger: ServiceContext["logger"],
): Promise<void> {
  try {
    const pluginConfig = api.pluginConfig as
      | Record<string, unknown>
      | undefined;
    const config = resolveHeartbeatConfig(pluginConfig);
    if (!config.enabled) return;

    const agents = discoverAgents(api.config);
    if (agents.length === 0) return;

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
    totalReviewTransitions: 0,
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
    result.totalReviewTransitions += agentResult.totalReviewTransitions;
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
    result.totalReviewTransitions > 0
  ) {
    logger.info(
      `work_heartbeat tick: ${result.totalPickups} pickups, ${result.totalHealthFixes} health fixes, ${result.totalReviewTransitions} review transitions, ${result.totalSkipped} skipped`,
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
  sessions: SessionLookup | null;
  logger: { info(msg: string): void; warn(msg: string): void };
}): Promise<TickResult> {
  const { workspaceDir, agentId, config, pluginConfig, sessions } = opts;

  const data = await readProjects(workspaceDir);
  const slugs = Object.keys(data.projects);

  if (slugs.length === 0) {
    return {
      totalPickups: 0,
      totalHealthFixes: 0,
      totalSkipped: 0,
      totalReviewTransitions: 0,
    };
  }

  const result: TickResult = {
    totalPickups: 0,
    totalHealthFixes: 0,
    totalSkipped: 0,
    totalReviewTransitions: 0,
  };

  const projectExecution =
    (pluginConfig?.projectExecution as string) ?? ExecutionMode.PARALLEL;
  let activeProjects = 0;

  for (const slug of slugs) {
    try {
      const project = data.projects[slug];
      if (!project) continue;

      const { provider } = await createProvider({
        repo: project.repo,
        provider: project.provider,
      });
      const resolvedConfig = await loadConfig(workspaceDir, project.name);

      // Health pass: auto-fix zombies and stale workers
      result.totalHealthFixes += await performHealthPass(
        workspaceDir,
        slug,
        project,
        sessions,
        provider,
        resolvedConfig.timeouts.staleWorkerHours,
      );

      // Review pass: transition issues whose PR check condition is met
      const notifyConfig = getNotificationConfig(pluginConfig);
      result.totalReviewTransitions += await reviewPass({
        workspaceDir,
        projectName: slug,
        workflow: resolvedConfig.workflow,
        provider,
        repoPath: project.repo,
        gitPullTimeoutMs: resolvedConfig.timeouts.gitPullMs,
        baseBranch: project.baseBranch,
        onMerge: (issueId, prUrl, prTitle, sourceBranch) => {
          provider
            .getIssue(issueId)
            .then((issue) => {
              const target = resolveNotifyChannel(
                issue.labels,
                project.channels,
              );
              notify(
                {
                  type: "prMerged",
                  project: project.name,
                  issueId,
                  issueUrl: issue.web_url,
                  issueTitle: issue.title,
                  prUrl: prUrl ?? undefined,
                  prTitle,
                  sourceBranch,
                  mergedBy: "heartbeat",
                },
                {
                  workspaceDir,
                  config: notifyConfig,
                  groupId: target?.groupId,
                  channel: target?.channel ?? "telegram",
                },
              ).catch(() => {});
            })
            .catch(() => {});
        },
        onFeedback: (issueId, reason, prUrl, issueTitle, issueUrl) => {
          const type =
            reason === "changes_requested"
              ? ("changesRequested" as const)
              : ("mergeConflict" as const);
          // No issue labels available in this callback — fall back to primary channel
          const target = project.channels[0];
          notify(
            {
              type,
              project: project.name,
              issueId,
              issueUrl,
              issueTitle,
              prUrl: prUrl ?? undefined,
            },
            {
              workspaceDir,
              config: notifyConfig,
              groupId: target?.groupId,
              channel: target?.channel ?? "telegram",
            },
          ).catch(() => {});
        },
        onPrClosed: (issueId, prUrl, issueTitle, issueUrl) => {
          // No issue labels available in this callback — fall back to primary channel
          const target = project.channels[0];
          notify(
            {
              type: "prClosed",
              project: project.name,
              issueId,
              issueUrl,
              issueTitle,
              prUrl: prUrl ?? undefined,
            },
            {
              workspaceDir,
              config: notifyConfig,
              groupId: target?.groupId,
              channel: target?.channel ?? "telegram",
            },
          ).catch(() => {});
        },
      });

      // Budget check: stop if we've hit the limit
      const remaining = config.maxPickupsPerTick - result.totalPickups;
      if (remaining <= 0) break;

      // Sequential project guard: don't start new projects if one is active
      const isProjectActive = await checkProjectActive(workspaceDir, slug);
      if (
        projectExecution === ExecutionMode.SEQUENTIAL &&
        !isProjectActive &&
        activeProjects >= 1
      ) {
        result.totalSkipped++;
        continue;
      }

      // Tick pass: fill free worker slots
      const tickResult = await projectTick({
        workspaceDir,
        projectSlug: slug,
        agentId,
        pluginConfig,
        maxPickups: remaining,
      });

      result.totalPickups += tickResult.pickups.length;
      result.totalSkipped += tickResult.skipped.length;

      // Notifications now handled by dispatchTask
      if (isProjectActive || tickResult.pickups.length > 0) activeProjects++;
    } catch (err) {
      // Per-project isolation: one failing project doesn't crash the entire tick
      opts.logger.warn(
        `Heartbeat tick failed for project ${slug}: ${(err as Error).message}`,
      );
      result.totalSkipped++;
    }
  }

  // Orphaned session scan: clean up subagent sessions not tracked by any project
  const orphanedSessionFixes = await scanOrphanedSessions({
    workspaceDir,
    sessions,
    autoFix: true,
  });
  result.totalHealthFixes += orphanedSessionFixes.filter((f) => f.fixed).length;

  await auditLog(workspaceDir, "heartbeat_tick", {
    projectsScanned: slugs.length,
    healthFixes: result.totalHealthFixes,
    reviewTransitions: result.totalReviewTransitions,
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
  projectSlug: string,
  project: any,
  sessions: SessionLookup | null,
  provider: import("../providers/provider.js").IssueProvider,
  staleWorkerHours?: number,
): Promise<number> {
  let fixedCount = 0;

  for (const role of Object.keys(project.workers)) {
    // Check worker health (session liveness, label consistency, etc)
    const healthFixes = await checkWorkerHealth({
      workspaceDir,
      projectSlug,
      project,
      role,
      sessions,
      autoFix: true,
      provider,
      staleWorkerHours,
    });
    fixedCount += healthFixes.filter((f) => f.fixed).length;

    // Scan for orphaned labels (active labels with no tracking worker)
    const orphanFixes = await scanOrphanedLabels({
      workspaceDir,
      projectSlug,
      project,
      role,
      autoFix: true,
      provider,
    });
    fixedCount += orphanFixes.filter((f) => f.fixed).length;
  }

  return fixedCount;
}

/**
 * Check if a project has any active worker.
 */
async function checkProjectActive(
  workspaceDir: string,
  slug: string,
): Promise<boolean> {
  const data = await readProjects(workspaceDir);
  const project = getProject(data, slug);
  if (!project) return false;
  return Object.values(project.workers).some((w) => w.active);
}
