/**
 * research_task — Spawn an architect to research a design/architecture problem.
 *
 * Dispatches the architect directly (no issue created yet).
 * The architect investigates, produces findings, and calls work_finish(result="done", summary="<findings>").
 * work_finish then creates the Planning issue with the findings as the body for human review.
 *
 * No issue appears until research is complete — Planning means "ready for human review".
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../types.js";
import { getWorker } from "../projects.js";
import { dispatchResearch } from "../dispatch.js";
import { log as auditLog } from "../audit.js";
import { requireWorkspaceDir, resolveProject, getPluginConfig } from "../tool-helpers.js";
import { loadConfig } from "../config/index.js";
import { selectLevel } from "../model-selector.js";
import { resolveModel } from "../roles/index.js";

export function createResearchTaskTool(api: OpenClawPluginApi) {
  return (ctx: ToolContext) => ({
    name: "research_task",
    label: "Research Task",
    description: `Spawn an architect to research a design/architecture problem. Dispatches architect directly — no issue created yet. The architect calls \`work_finish(result='done', summary='<findings>')\` which creates the Planning issue for human review.

IMPORTANT: Provide a detailed description with enough background context for the architect
to produce actionable, development-ready findings. Include: current state, constraints,
requirements, relevant code paths, and any prior decisions. The output should be detailed
enough for a developer to start implementation immediately.

The architect will:
1. Research the problem systematically (codebase, docs, web)
2. Investigate >= 3 alternatives with tradeoffs
3. Produce a recommendation with implementation outline
4. Call work_finish(result="done", summary="<findings>") — this creates the Planning issue for human review

Example:
  research_task({
    projectGroupId: "-5176490302",
    title: "Research: Session persistence strategy",
    description: "Sessions are lost on restart. Current impl uses in-memory Map in session-store.ts. Constraints: must work with SQLite (already a dep), max 50ms latency on read. Prior discussion in #42 ruled out Redis.",
    focusAreas: ["SQLite vs file-based", "migration path", "cache invalidation"],
    complexity: "complex"
  })`,
    parameters: {
      type: "object",
      required: ["projectGroupId", "title", "description"],
      properties: {
        projectGroupId: {
          type: "string",
          description: "Project group ID",
        },
        title: {
          type: "string",
          description: "Research title (e.g., 'Research: Session persistence strategy')",
        },
        description: {
          type: "string",
          description: "Detailed background context: what exists today, why this needs investigation, constraints, relevant code paths, prior decisions. Must be detailed enough for the architect to produce development-ready findings.",
        },
        focusAreas: {
          type: "array",
          items: { type: "string" },
          description: "Specific areas to investigate (e.g., ['performance', 'scalability', 'simplicity'])",
        },
        complexity: {
          type: "string",
          enum: ["simple", "medium", "complex"],
          description: "Suggests architect level: simple/medium → junior, complex → senior. Defaults to medium.",
        },
        dryRun: {
          type: "boolean",
          description: "Preview without executing. Defaults to false.",
        },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const groupId = params.projectGroupId as string;
      const title = params.title as string;
      const description = (params.description as string) ?? "";
      const focusAreas = (params.focusAreas as string[]) ?? [];
      const complexity = (params.complexity as "simple" | "medium" | "complex") ?? "medium";
      const dryRun = (params.dryRun as boolean) ?? false;
      const workspaceDir = requireWorkspaceDir(ctx);

      if (!groupId) throw new Error("projectGroupId is required");
      if (!title) throw new Error("title is required");
      if (!description) throw new Error("description is required — provide detailed background context for the architect");

      const { project } = await resolveProject(workspaceDir, groupId);
      const pluginConfig = getPluginConfig(api);
      const role = "architect";

      await auditLog(workspaceDir, "research_task", {
        project: project.name, groupId, title, complexity, focusAreas, dryRun,
      });

      // Select level: use complexity hint to guide the heuristic
      const level = complexity === "complex"
        ? selectLevel(title, "system-wide " + description, role).level
        : selectLevel(title, description, role).level;
      const resolvedConfig = await loadConfig(workspaceDir, project.name);
      const resolvedRole = resolvedConfig.roles[role];
      const model = resolveModel(role, level, resolvedRole);

      if (dryRun) {
        return jsonResult({
          success: true,
          dryRun: true,
          research: { title, level, model, status: "dry_run" },
          announcement: `📐 [DRY RUN] Would dispatch ${role} (${level}) to research: ${title}`,
        });
      }

      // Check worker availability
      const worker = getWorker(project, role);
      if (worker.active) {
        return jsonResult({
          success: false,
          research: {
            level,
            status: "busy",
            reason: `${role.toUpperCase()} already active on #${worker.issueId ?? "pending"}. Try again when the current research completes.`,
          },
          announcement: `📐 ${role.toUpperCase()} busy — cannot dispatch research for: ${title}`,
        });
      }

      // Dispatch architect directly — no issue created yet.
      // The architect calls work_finish(result="done", summary="<findings>")
      // which creates the Planning issue with findings as the body.
      const dr = await dispatchResearch({
        workspaceDir,
        agentId: ctx.agentId,
        groupId,
        project,
        role,
        level,
        researchTitle: title,
        researchDescription: description,
        focusAreas,
        pluginConfig,
        channel: project.channel,
        sessionKey: ctx.sessionKey,
        runtime: api.runtime,
      });

      return jsonResult({
        success: true,
        research: {
          sessionKey: dr.sessionKey,
          level: dr.level,
          model: dr.model,
          sessionAction: dr.sessionAction,
          status: "in_progress",
          note: "Planning issue will be created when architect calls work_finish",
        },
        project: project.name,
        announcement: dr.announcement,
      });
    },
  });
}
