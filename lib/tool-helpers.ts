/**
 * tool-helpers.ts — Shared resolution helpers for tool execute() functions.
 *
 * Eliminates repeated boilerplate across tools: workspace validation,
 * context detection, project resolution, provider creation.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "./types.js";
import type { InteractionContext } from "./context-guard.js";
import { detectContext, generateGuardrails } from "./context-guard.js";
import { readProjects, getProject, type Project, type ProjectsData } from "./projects.js";
import { createProvider, type ProviderWithType } from "./providers/index.js";
import { projectTick, type TickAction } from "./services/tick.js";
import { notifyTickPickups, getNotificationConfig } from "./notify.js";

/**
 * Require workspaceDir from context or throw a clear error.
 */
export function requireWorkspaceDir(ctx: ToolContext): string {
  if (!ctx.workspaceDir) {
    throw new Error("No workspace directory available in tool context");
  }
  return ctx.workspaceDir;
}

/**
 * Detect interaction context (via-agent, direct, or group).
 * Extracts devClawAgentIds from plugin config automatically.
 */
export async function resolveContext(
  ctx: ToolContext,
  api: OpenClawPluginApi,
): Promise<InteractionContext> {
  const devClawAgentIds =
    ((api.pluginConfig as Record<string, unknown>)?.devClawAgentIds as string[] | undefined) ?? [];
  return detectContext(ctx, devClawAgentIds);
}

/**
 * Resolve project by groupId, throw if not found.
 */
export async function resolveProject(
  workspaceDir: string,
  groupId: string,
): Promise<{ data: ProjectsData; project: Project }> {
  const data = await readProjects(workspaceDir);
  const project = getProject(data, groupId);
  if (!project) {
    throw new Error(`Project not found for groupId ${groupId}. Run project_register first.`);
  }
  return { data, project };
}

/**
 * Create an issue provider for a project.
 */
export function resolveProvider(project: Project): ProviderWithType {
  return createProvider({ repo: project.repo });
}

/**
 * Return a standard "group-only" error response for tools restricted to group chats.
 */
export function groupOnlyError(toolName: string, context: InteractionContext) {
  return jsonResult({
    success: false,
    error: `${toolName} can only be used in project group chats.`,
    recommendation: context.type === "via-agent"
      ? "Use onboard instead for setup."
      : "Use the relevant project group.",
    contextGuidance: generateGuardrails(context),
  });
}

/**
 * Get plugin config as a typed record (or undefined).
 */
export function getPluginConfig(api: OpenClawPluginApi): Record<string, unknown> | undefined {
  return api.pluginConfig as Record<string, unknown> | undefined;
}

/**
 * Run projectTick (non-fatal) and send workerStart notifications for any pickups.
 * Returns the pickups array (empty on failure).
 */
export async function tickAndNotify(opts: {
  workspaceDir: string;
  groupId: string;
  agentId?: string;
  pluginConfig?: Record<string, unknown>;
  sessionKey?: string;
  targetRole?: "dev" | "qa";
  channel?: string;
}): Promise<TickAction[]> {
  let pickups: TickAction[] = [];
  try {
    const result = await projectTick({
      workspaceDir: opts.workspaceDir,
      groupId: opts.groupId,
      agentId: opts.agentId,
      pluginConfig: opts.pluginConfig,
      sessionKey: opts.sessionKey,
      targetRole: opts.targetRole,
    });
    pickups = result.pickups;
  } catch { /* non-fatal: tick failure shouldn't break the caller */ }

  if (pickups.length) {
    const notifyConfig = getNotificationConfig(opts.pluginConfig);
    await notifyTickPickups(pickups, {
      workspaceDir: opts.workspaceDir,
      config: notifyConfig,
      channel: opts.channel,
    });
  }

  return pickups;
}
