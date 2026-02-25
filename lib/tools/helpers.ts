/**
 * tool-helpers.ts — Shared resolution helpers for tool execute() functions.
 *
 * Eliminates repeated boilerplate across tools: workspace validation,
 * project resolution, provider creation.
 */
import type { ToolContext } from "../types.js";
import type { RunCommand } from "../context.js";
import { readProjects, getProject, type Project, type ProjectsData } from "../projects/index.js";
import { createProvider, type ProviderWithType } from "../providers/index.js";
import { loadConfig } from "../config/index.js";
import { loadInstanceName } from "../instance.js";
import { getOwnerLabel, OWNER_LABEL_COLOR, getNotifyLabel, NOTIFY_LABEL_PREFIX, NOTIFY_LABEL_COLOR } from "../workflow/index.js";

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
 * Resolve the channelId from explicit tool param.
 */
export function resolveChannelId(_ctx: ToolContext, explicitChannelId?: string): string {
  if (!explicitChannelId) {
    throw new Error(
      "channelId is required. Pass YOUR chat/group ID (the numeric ID of the chat you are in right now).",
    );
  }
  return explicitChannelId;
}

/**
 * Resolve project by channelId (or slug for backward compat).
 * Throws with actionable guidance if not found.
 */
export async function resolveProject(
  workspaceDir: string,
  channelId: string,
): Promise<{ data: ProjectsData; project: Project }> {
  const data = await readProjects(workspaceDir);
  const project = getProject(data, channelId);
  if (!project) {
    throw new Error(
      `No project found for "${channelId}". ` +
      `Register a new project with project_register, or link this channel to an existing project.`,
    );
  }
  return { data, project };
}

/**
 * Create an issue provider for a project.
 * Uses stored provider type from project config if available, otherwise auto-detects.
 */
export async function resolveProvider(project: Project, runCommand: RunCommand): Promise<ProviderWithType> {
  return createProvider({ repo: project.repo, provider: project.provider, runCommand });
}

/**
 * Auto-assign owner label to an issue based on the current instance.
 *
 * This ensures that when a task tool creates or modifies an issue,
 * it automatically claims ownership for the executing instance.
 * Best-effort: failures are logged but don't block the operation.
 */
/**
 * Apply a notify label to an issue for notification channel routing.
 *
 * Each issue has at most one notify label. If the source channel differs
 * from the existing label, the old one is replaced.
 * Best-effort: failures are silently ignored.
 *
 * @param sourceChannelId — The channelId the request came from (optional).
 *   When provided, routes to the matching channel. Falls back to first channel.
 */
export function applyNotifyLabel(
  provider: ProviderWithType["provider"],
  issueId: number,
  project: Project,
  sourceChannelId?: string,
  existingLabels?: string[],
): void {
  const sourceChannel =
    (sourceChannelId ? project.channels.find(ch => ch.channelId === sourceChannelId) : undefined) ??
    project.channels[0];
  if (!sourceChannel) return;

  const notifyLabel = getNotifyLabel(sourceChannel.channel, sourceChannel.name ?? "0");
  const staleLabels = existingLabels?.filter(l => l.startsWith(NOTIFY_LABEL_PREFIX) && l !== notifyLabel) ?? [];
  const hasCorrectLabel = existingLabels?.includes(notifyLabel) ?? false;

  // Nothing to do — correct label present, no stale labels
  if (hasCorrectLabel && staleLabels.length === 0) return;

  const apply = async () => {
    if (staleLabels.length > 0) {
      await provider.removeLabels(issueId, staleLabels);
    }
    if (!hasCorrectLabel) {
      await provider.ensureLabel(notifyLabel, NOTIFY_LABEL_COLOR);
      await provider.addLabel(issueId, notifyLabel);
    }
  };
  apply().catch(() => {});
}

/**
 * Auto-assign owner label to an issue based on the current instance.
 *
 * This ensures that when a task tool creates or modifies an issue,
 * it automatically claims ownership for the executing instance.
 * Best-effort: failures are logged but don't block the operation.
 */
export async function autoAssignOwnerLabel(
  workspaceDir: string,
  provider: ProviderWithType["provider"],
  issueId: number,
  project: Project,
): Promise<void> {
  try {
    const resolvedConfig = await loadConfig(workspaceDir, project.name);
    const instanceName = await loadInstanceName(
      workspaceDir,
      resolvedConfig.instanceName,
    );
    const ownerLabel = getOwnerLabel(instanceName);

    // Ensure the owner label exists in the issue tracker
    await provider.ensureLabel(ownerLabel, OWNER_LABEL_COLOR);

    // Add the owner label to the issue
    await provider.addLabel(issueId, ownerLabel);
  } catch (error) {
    // Log but don't block: auto-assigning owner label is best-effort
    console.warn(`Failed to auto-assign owner label to issue #${issueId}:`, error);
  }
}
