/**
 * design_task — Spawn an architect to investigate a design problem.
 *
 * Creates a "To Design" issue and optionally dispatches an architect worker.
 * The architect investigates systematically, then produces structured findings
 * as a GitHub issue in Planning state.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../types.js";
import type { StateLabel } from "../providers/provider.js";
import { getWorker } from "../projects.js";
import { dispatchTask } from "../dispatch.js";
import { log as auditLog } from "../audit.js";
import { requireWorkspaceDir, resolveProject, resolveProvider, getPluginConfig } from "../tool-helpers.js";
import { DEFAULT_WORKFLOW, getActiveLabel } from "../workflow.js";

export function createDesignTaskTool(api: OpenClawPluginApi) {
  return (ctx: ToolContext) => ({
    name: "design_task",
    label: "Design Task",
    description: `Spawn an architect to investigate a design/architecture problem. Creates a "To Design" issue and dispatches an architect worker with persistent session.

The architect will:
1. Investigate the problem systematically
2. Research alternatives (>= 3 options)
3. Produce structured findings with recommendation
4. Complete with work_finish, moving the issue to Planning

Example:
  design_task({
    projectGroupId: "-5176490302",
    title: "Design: Session persistence strategy",
    description: "How should sessions be persisted across restarts?",
    complexity: "complex"
  })`,
    parameters: {
      type: "object",
      required: ["projectGroupId", "title"],
      properties: {
        projectGroupId: {
          type: "string",
          description: "Project group ID",
        },
        title: {
          type: "string",
          description: "Design title (e.g., 'Design: Session persistence')",
        },
        description: {
          type: "string",
          description: "What are we designing & why? Include context and constraints.",
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

      const { project } = await resolveProject(workspaceDir, groupId);
      const { provider } = await resolveProvider(project);

      // Build issue body with focus areas
      const bodyParts = [description];
      if (focusAreas.length > 0) {
        bodyParts.push("", "## Focus Areas", ...focusAreas.map(a => `- ${a}`));
      }
      bodyParts.push(
        "", "---",
        "", "## Architect Output Template",
        "",
        "When complete, the architect will produce findings covering:",
        "1. **Problem Statement** — Why is this design decision important?",
        "2. **Current State** — What exists today? Limitations?",
        "3. **Alternatives** (>= 3 options with pros/cons and effort estimates)",
        "4. **Recommendation** — Which option and why?",
        "5. **Implementation Outline** — What dev tasks are needed?",
        "6. **References** — Code, docs, prior art",
      );
      const issueBody = bodyParts.join("\n");

      // Create issue in To Design state
      const issue = await provider.createIssue(title, issueBody, "To Design" as StateLabel);

      await auditLog(workspaceDir, "design_task", {
        project: project.name, groupId, issueId: issue.iid,
        title, complexity, focusAreas, dryRun,
      });

      // Select level based on complexity
      const level = complexity === "complex" ? "senior" : "junior";

      if (dryRun) {
        return jsonResult({
          success: true,
          dryRun: true,
          issue: { id: issue.iid, title: issue.title, url: issue.web_url, label: "To Design" },
          design: {
            level,
            model: complexity === "complex" ? "anthropic/claude-opus-4-5" : "anthropic/claude-sonnet-4-5",
            status: "dry_run",
          },
          announcement: `📐 [DRY RUN] Would spawn architect (${level}) for #${issue.iid}: ${title}\n🔗 ${issue.web_url}`,
        });
      }

      // Check architect availability
      const worker = getWorker(project, "architect");
      if (worker.active) {
        // Issue created but can't dispatch yet — will be picked up by heartbeat
        return jsonResult({
          success: true,
          issue: { id: issue.iid, title: issue.title, url: issue.web_url, label: "To Design" },
          design: {
            level,
            status: "queued",
            reason: `Architect already active on #${worker.issueId}. Issue queued for pickup.`,
          },
          announcement: `📐 Created design task #${issue.iid}: ${title} (queued — architect busy)\n🔗 ${issue.web_url}`,
        });
      }

      // Dispatch architect
      const workflow = DEFAULT_WORKFLOW;
      const targetLabel = getActiveLabel(workflow, "architect");
      const pluginConfig = getPluginConfig(api);

      const dr = await dispatchTask({
        workspaceDir,
        agentId: ctx.agentId,
        groupId,
        project,
        issueId: issue.iid,
        issueTitle: issue.title,
        issueDescription: issueBody,
        issueUrl: issue.web_url,
        role: "architect",
        level,
        fromLabel: "To Design",
        toLabel: targetLabel,
        transitionLabel: (id, from, to) => provider.transitionLabel(id, from as StateLabel, to as StateLabel),
        provider,
        pluginConfig,
        channel: project.channel,
        sessionKey: ctx.sessionKey,
        runtime: api.runtime,
      });

      return jsonResult({
        success: true,
        issue: { id: issue.iid, title: issue.title, url: issue.web_url, label: targetLabel },
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
