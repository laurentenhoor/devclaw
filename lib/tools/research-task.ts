/**
 * research_task — Spawn an architect to research a design/architecture problem.
 *
 * Creates a Planning issue with rich context and dispatches an architect worker.
 * The architect researches the problem and produces detailed findings as issue comments.
 * The issue stays in Planning — ready for human review when the architect completes.
 *
 * No queue states — tool-triggered only.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../types.js";
import type { StateLabel } from "../providers/provider.js";
import { getWorker } from "../projects.js";
import { dispatchTask } from "../dispatch.js";
import { log as auditLog } from "../audit.js";
import { requireWorkspaceDir, resolveProject, resolveProvider, getPluginConfig } from "../tool-helpers.js";
import { loadConfig } from "../config/index.js";
import { selectLevel } from "../model-selector.js";
import { resolveModel } from "../roles/index.js";

/** Planning label — architect issues go directly here. */
const PLANNING_LABEL = "Planning";

export function createResearchTaskTool(api: OpenClawPluginApi) {
  return (ctx: ToolContext) => ({
    name: "research_task",
    label: "Research Task",
    description: `Spawn an architect to research a design/architecture problem. Creates a Planning issue and dispatches an architect worker.

IMPORTANT: Provide a detailed description with enough background context for the architect
to produce actionable, development-ready findings. Include: current state, constraints,
requirements, relevant code paths, and any prior decisions. The output should be detailed
enough for a developer to start implementation immediately.

The architect will:
1. Research the problem systematically (codebase, docs, web)
2. Investigate >= 3 alternatives with tradeoffs
3. Produce a recommendation with implementation outline
4. Post findings as issue comments, then complete with work_finish

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
      const { provider } = await resolveProvider(project);
      const pluginConfig = getPluginConfig(api);
      const role = "architect";

      // Build issue body with rich context
      const bodyParts = [
        "## Background",
        "",
        description,
      ];
      if (focusAreas.length > 0) {
        bodyParts.push("", "## Focus Areas", ...focusAreas.map(a => `- ${a}`));
      }
      const issueBody = bodyParts.join("\n");

      // Create issue directly in Planning state (no queue — tool-triggered only)
      const issue = await provider.createIssue(title, issueBody, PLANNING_LABEL as StateLabel);

      await auditLog(workspaceDir, "research_task", {
        project: project.name, groupId, issueId: issue.iid,
        title, complexity, focusAreas, dryRun,
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
          issue: { id: issue.iid, title: issue.title, url: issue.web_url, label: PLANNING_LABEL },
          design: { level, model, status: "dry_run" },
          announcement: `📐 [DRY RUN] Would spawn ${role} (${level}) for #${issue.iid}: ${title}\n🔗 ${issue.web_url}`,
        });
      }

      // Check worker availability
      const worker = getWorker(project, role);
      if (worker.active) {
        return jsonResult({
          success: true,
          issue: { id: issue.iid, title: issue.title, url: issue.web_url, label: PLANNING_LABEL },
          design: {
            level,
            status: "queued",
            reason: `${role.toUpperCase()} already active on #${worker.issueId}. Issue created in Planning — dispatch manually when architect is free.`,
          },
          announcement: `📐 Created research task #${issue.iid}: ${title} (architect busy — issue in Planning)\n🔗 ${issue.web_url}`,
        });
      }

      // Dispatch architect directly — issue stays in Planning (no state transition)
      const dr = await dispatchTask({
        workspaceDir,
        agentId: ctx.agentId,
        groupId,
        project,
        issueId: issue.iid,
        issueTitle: issue.title,
        issueDescription: issueBody,
        issueUrl: issue.web_url,
        role,
        level,
        fromLabel: PLANNING_LABEL,
        toLabel: PLANNING_LABEL,
        transitionLabel: (id, from, to) => provider.transitionLabel(id, from as StateLabel, to as StateLabel),
        provider,
        pluginConfig,
        channel: project.channel,
        sessionKey: ctx.sessionKey,
        runtime: api.runtime,
      });

      return jsonResult({
        success: true,
        issue: { id: issue.iid, title: issue.title, url: issue.web_url, label: PLANNING_LABEL },
        design: {
          sessionKey: dr.sessionKey,
          level: dr.level,
          model: dr.model,
          sessionAction: dr.sessionAction,
          status: "in_progress",
        },
        project: project.name,
        announcement: dr.announcement,
      });
    },
  });
}
