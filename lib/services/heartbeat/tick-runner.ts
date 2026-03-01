/**
 * Tick runner — main heartbeat loop that processes each project.
 */
import type { PluginRuntime } from "openclaw/plugin-sdk";
import type { RunCommand } from "../../context.js";
import path from "node:path";
import { readProjects, getProject, type Project } from "../../projects/index.js";
import { log as auditLog } from "../../audit.js";
import { DATA_DIR } from "../../setup/migrate-layout.js";
import { loadInstanceName } from "../../instance.js";
import {
  type SessionLookup,
} from "./health.js";
import { projectTick } from "../tick.js";
import { createProvider } from "../../providers/index.js";
import { loadConfig } from "../../config/index.js";
import { ExecutionMode } from "../../workflow/index.js";
import type { HeartbeatConfig } from "./config.js";
import {
  performHealthPass,
  performReviewPass,
  performReviewSkipPass,
  performTestSkipPass,
} from "./passes.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TickResult = {
  totalPickups: number;
  totalHealthFixes: number;
  totalSkipped: number;
  totalReviewTransitions: number;
  totalReviewSkipTransitions: number;
  totalTestSkipTransitions: number;
};

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
  runtime?: PluginRuntime;
  runCommand: RunCommand;
}): Promise<TickResult> {
  const { workspaceDir, agentId, config, pluginConfig, sessions, runtime, runCommand } = opts;

  // Load instance name for ownership filtering and auto-claiming
  const resolvedWorkspaceConfig = await loadConfig(workspaceDir);
  const instanceName = await loadInstanceName(workspaceDir, resolvedWorkspaceConfig.instanceName);

  const data = await readProjects(workspaceDir);
  const slugs = Object.keys(data.projects);

  if (slugs.length === 0) {
    return {
      totalPickups: 0,
      totalHealthFixes: 0,
      totalSkipped: 0,
      totalReviewTransitions: 0,
      totalReviewSkipTransitions: 0,
      totalTestSkipTransitions: 0,
    };
  }

  const result: TickResult = {
    totalPickups: 0,
    totalHealthFixes: 0,
    totalSkipped: 0,
    totalReviewTransitions: 0,
    totalReviewSkipTransitions: 0,
    totalTestSkipTransitions: 0,
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
        runCommand,
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
        instanceName,
        runCommand,
        resolvedConfig.timeouts.stallTimeoutMinutes,
        agentId,
      );

      // Review pass: transition issues whose PR check condition is met
      result.totalReviewTransitions += await performReviewPass(
        workspaceDir, slug, project, provider, resolvedConfig, pluginConfig, runtime, runCommand,
      );

      // Review skip pass: auto-merge and transition review:skip issues through the review queue
      result.totalReviewSkipTransitions += await performReviewSkipPass(
        workspaceDir, slug, project, provider, resolvedConfig, pluginConfig, runtime, runCommand,
      );

      // Test skip pass: auto-transition test:skip issues through the test queue
      result.totalTestSkipTransitions += await performTestSkipPass(
        workspaceDir, slug, provider, resolvedConfig,
      );

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
        instanceName,
        runtime,
        runCommand,
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

  await auditLog(workspaceDir, "heartbeat_tick", {
    projectsScanned: slugs.length,
    healthFixes: result.totalHealthFixes,
    reviewTransitions: result.totalReviewTransitions,
    reviewSkipTransitions: result.totalReviewSkipTransitions,
    testSkipTransitions: result.totalTestSkipTransitions,
    pickups: result.totalPickups,
    skipped: result.totalSkipped,
  });

  return result;
}

/**
 * Check if a project has any active worker.
 */
export async function checkProjectActive(
  workspaceDir: string,
  slug: string,
): Promise<boolean> {
  const data = await readProjects(workspaceDir);
  const project = getProject(data, slug);
  if (!project) return false;
  return Object.values(project.workers).some((w) =>
    Object.values(w.levels).some(slots => slots.some(s => s.active)),
  );
}
