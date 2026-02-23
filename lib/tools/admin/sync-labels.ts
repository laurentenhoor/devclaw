/**
 * sync_labels — Sync GitHub/GitLab labels with the current workflow config.
 *
 * Creates any missing state labels, role:level labels, and step routing labels
 * from the resolved (three-layer merged) config. Use after editing workflow.yaml
 * to push label changes to your issue tracker.
 *
 * Calls provider.ensureLabel() directly instead of provider.ensureAllStateLabels()
 * so that custom workflow states from workspace/project overrides are included.
 */
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../../types.js";
import type { PluginContext } from "../../context.js";
import { requireWorkspaceDir } from "../helpers.js";
import { readProjects, getProject } from "../../projects/index.js";
import { createProvider } from "../../providers/index.js";
import { loadConfig } from "../../config/index.js";
import {
  getStateLabels,
  getLabelColors,
  getRoleLabels,
} from "../../workflow/index.js";
import { log as auditLog } from "../../audit.js";

export function createSyncLabelsTool(ctx: PluginContext) {
  return (toolCtx: ToolContext) => ({
    name: "sync_labels",
    label: "Sync Labels",
    description:
      "Sync GitHub/GitLab labels with the current workflow config. " +
      "Creates any missing state labels, role:level labels, and step routing labels. " +
      "Use after editing workflow.yaml to push label changes to your issue tracker.",
    parameters: {
      type: "object",
      properties: {
        projectSlug: {
          type: "string",
          description:
            "Project slug to sync. Omit to sync all registered projects.",
        },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const workspaceDir = requireWorkspaceDir(toolCtx);
      const targetSlug = params.projectSlug as string | undefined;

      const data = await readProjects(workspaceDir);
      let slugs: string[];

      if (targetSlug) {
        const project = data.projects[targetSlug] ?? getProject(data, targetSlug);
        if (!project) {
          throw new Error(
            `Project "${targetSlug}" not found. Run project_register first.`,
          );
        }
        slugs = [project.slug];
      } else {
        slugs = Object.keys(data.projects);
      }

      if (slugs.length === 0) {
        return jsonResult({ success: true, synced: [], message: "No projects registered." });
      }

      const results: Array<{
        project: string;
        stateLabels: string[];
        roleLabels: string[];
        error?: string;
      }> = [];

      for (const slug of slugs) {
        const project = data.projects[slug];
        if (!project) continue;

        try {
          const resolvedConfig = await loadConfig(workspaceDir, project.name);

          const { provider } = await createProvider({
            repo: project.repo,
            provider: project.provider,
            runCommand: ctx.runCommand,
          });

          // State labels from the resolved workflow (not DEFAULT_WORKFLOW)
          const stateLabels = getStateLabels(resolvedConfig.workflow);
          const labelColors = getLabelColors(resolvedConfig.workflow);
          for (const label of stateLabels) {
            await provider.ensureLabel(label, labelColors[label]);
          }

          // Role:level + step routing labels
          const roleLabels = getRoleLabels(resolvedConfig.roles);
          for (const { name, color } of roleLabels) {
            await provider.ensureLabel(name, color);
          }

          results.push({
            project: slug,
            stateLabels,
            roleLabels: roleLabels.map((r) => r.name),
          });
        } catch (err) {
          results.push({
            project: slug,
            stateLabels: [],
            roleLabels: [],
            error: (err as Error).message,
          });
        }
      }

      await auditLog(workspaceDir, "sync_labels", {
        projects: results.map((r) => r.project),
        errors: results.filter((r) => r.error).length,
      });

      return jsonResult({
        success: results.every((r) => !r.error),
        synced: results,
      });
    },
  });
}
