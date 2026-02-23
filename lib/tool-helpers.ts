/**
 * tool-helpers.ts — Shared resolution helpers for tool execute() functions.
 *
 * Eliminates repeated boilerplate across tools: workspace validation,
 * project resolution, provider creation.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { ToolContext } from "./types.js";
import { readProjects, getProject, type Project, type ProjectsData } from "./projects.js";
import { createProvider, type ProviderWithType } from "./providers/index.js";
import { loadConfig } from "./config/index.js";
import { loadInstanceName } from "./instance.js";
import { getOwnerLabel, OWNER_LABEL_COLOR } from "./workflow.js";

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
 * Resolve project by slug or groupId (dual-mode resolution).
 * Throws if not found.
 */
export async function resolveProject(
  workspaceDir: string,
  slugOrGroupId: string,
): Promise<{ data: ProjectsData; project: Project }> {
  const data = await readProjects(workspaceDir);
  const project = getProject(data, slugOrGroupId);
  if (!project) {
    throw new Error(`Project not found for slug or groupId "${slugOrGroupId}". Run project_register first.`);
  }
  return { data, project };
}

/**
 * Create an issue provider for a project.
 * Uses stored provider type from project config if available, otherwise auto-detects.
 */
export async function resolveProvider(project: Project): Promise<ProviderWithType> {
  return createProvider({ repo: project.repo, provider: project.provider });
}

/**
 * Get plugin config as a typed record (or undefined).
 */
export function getPluginConfig(api: OpenClawPluginApi): Record<string, unknown> | undefined {
  return api.pluginConfig as Record<string, unknown> | undefined;
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
