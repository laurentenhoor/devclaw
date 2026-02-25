/**
 * research_task — Start a research ticket in "To Research" state and dispatch the architect.
 *
 * The architect picks up the issue, researches, posts findings, and creates
 * implementation tasks via task_create. Then calls work_finish(result="done")
 * which closes the research issue (findings preserved in comments).
 *
 * Flow:
 *   research_task() → issue created in "To Research" → architect dispatched
 *   → architect researches, posts findings with task_comment
 *   → architect creates implementation tasks with task_create (land in Planning)
 *   → architect calls work_finish(result="done") → "Researching" → "Done" (issue closed)
 *   → operator reviews created tasks in Planning, moves to "To Do" when ready
 */
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../../types.js";
import type { PluginContext } from "../../context.js";
import type { StateLabel } from "../../providers/provider.js";
import { getRoleWorker, countActiveSlots } from "../../projects/index.js";
import { dispatchTask } from "../../dispatch/index.js";
import { log as auditLog } from "../../audit.js";
import { requireWorkspaceDir, resolveProject, resolveProvider, autoAssignOwnerLabel } from "../helpers.js";
import { loadConfig } from "../../config/index.js";
import { getNotifyLabel, NOTIFY_LABEL_COLOR, NOTIFY_LABEL_PREFIX, getActiveLabel } from "../../workflow/index.js";
import { selectLevel } from "../../roles/model-selector.js";
import { resolveModel } from "../../roles/index.js";

/** Queue label for research tasks. */
const TO_RESEARCH_LABEL = "To Research";

export function createResearchTaskTool(ctx: PluginContext) {
  return (toolCtx: ToolContext) => ({
    name: "research_task",
    label: "Research Task",
    description: `Spawn an architect to research a design/architecture problem. Creates a "To Research" issue and dispatches an architect worker.

IMPORTANT: Provide a detailed description with enough background context for the architect
to produce actionable, development-ready findings. Include: current state, constraints,
requirements, relevant code paths, and any prior decisions. The output should be detailed
enough for a developer to start implementation immediately.

The architect will:
1. Research the problem systematically (codebase, docs, web)
2. Post findings as comments via task_comment
3. Create implementation tasks via task_create (land in Planning for operator review)
4. Call work_finish(result="done", summary="<recommendation + task numbers>") — closes the research issue

Example:
  research_task({
    projectSlug: "my-webapp",
    title: "Research: Session persistence strategy",
    description: "Sessions are lost on restart. Current impl uses in-memory Map in session-store.ts. Constraints: must work with SQLite (already a dep), max 50ms latency on read. Prior discussion in #42 ruled out Redis.",
    focusAreas: ["SQLite vs file-based", "migration path", "cache invalidation"],
    complexity: "complex"
  })`,
    parameters: {
      type: "object",
      required: ["projectSlug", "title", "description"],
      properties: {
        projectSlug: {
          type: "string",
          description: "Project slug (e.g. 'my-webapp').",
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
      const slug = (params.projectSlug ?? params.projectGroupId) as string;
      const title = params.title as string;
      const description = (params.description as string) ?? "";
      const focusAreas = (params.focusAreas as string[]) ?? [];
      const complexity = (params.complexity as "simple" | "medium" | "complex") ?? "medium";
      const dryRun = (params.dryRun as boolean) ?? false;
      const workspaceDir = requireWorkspaceDir(toolCtx);

      if (!slug) throw new Error("projectSlug is required");
      if (!title) throw new Error("title is required");
      if (!description) throw new Error("description is required — provide detailed background context for the architect");

      const { project } = await resolveProject(workspaceDir, slug);
      const { provider } = await resolveProvider(project, ctx.runCommand);
      const pluginConfig = ctx.pluginConfig;
      const role = "architect";

      // Build issue body with rich context for the architect to start from
      const bodyParts = ["## Background", "", description];
      if (focusAreas.length > 0) {
        bodyParts.push("", "## Focus Areas", ...focusAreas.map((a) => `- ${a}`));
      }
      const issueBody = bodyParts.join("\n");

      await auditLog(workspaceDir, "research_task", {
        project: project.name, title, complexity, focusAreas, dryRun,
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
          issue: { title, label: TO_RESEARCH_LABEL },
          research: { level, model, status: "dry_run" },
          announcement: `\u{1f4d0} [DRY RUN] Would create research ticket and dispatch ${role} (${level}) for: ${title}`,
        });
      }

      // Create issue in "To Research" (the architect queue state)
      const issue = await provider.createIssue(title, issueBody, TO_RESEARCH_LABEL as StateLabel);

      // Mark as system-managed (best-effort).
      provider.reactToIssue(issue.iid, "eyes").catch(() => {});

      // Apply notify label for notification routing (best-effort)
      const primaryChannel = project.channels[0];
      const notifyLabel = primaryChannel ? getNotifyLabel(primaryChannel.channel, primaryChannel.name ?? "0") : null;
      if (notifyLabel) {
        const hasNotify = issue.labels.some((l) => l.startsWith(NOTIFY_LABEL_PREFIX));
        if (!hasNotify) {
          provider.ensureLabel(notifyLabel, NOTIFY_LABEL_COLOR)
            .then(() => provider.addLabel(issue.iid, notifyLabel))
            .catch(() => {});
        }
      }

      // Auto-assign owner label to this instance (best-effort).
      autoAssignOwnerLabel(workspaceDir, provider, issue.iid, project).catch(() => {});

      // Check worker availability across all levels
      const roleWorker = getRoleWorker(project, role);
      if (countActiveSlots(roleWorker) > 0) {
        // Architect is busy — issue created in queue, heartbeat will pick it up when free
        // Find any active slot's issueId for the message
        const activeIssueId = Object.values(roleWorker.levels)
          .flat()
          .find((s) => s.active)?.issueId;
        return jsonResult({
          success: true,
          issue: { id: issue.iid, title: issue.title, url: issue.web_url, label: TO_RESEARCH_LABEL },
          research: {
            level,
            status: "queued",
            reason: `${role.toUpperCase()} already active on #${activeIssueId}. Research ticket queued — architect will pick it up when current work completes.`,
          },
          announcement: `\u{1f4d0} Created research ticket #${issue.iid}: ${title} (architect busy — queued)\n\u{1f517} [Issue #${issue.iid}](${issue.web_url})`,
        });
      }

      // Dispatch architect via standard dispatchTask — same pipeline as every other role.
      // fromLabel: "To Research" (queue), toLabel: "Researching" (active)
      const toLabel = getActiveLabel(resolvedConfig.workflow, role);
      const dr = await dispatchTask({
        workspaceDir,
        agentId: toolCtx.agentId,
        project,
        issueId: issue.iid,
        issueTitle: issue.title,
        issueDescription: issueBody,
        issueUrl: issue.web_url,
        role,
        level,
        fromLabel: TO_RESEARCH_LABEL,
        toLabel,
        provider,
        pluginConfig,
        sessionKey: toolCtx.sessionKey,
        runtime: ctx.runtime,
        runCommand: ctx.runCommand,
      });

      return jsonResult({
        success: true,
        issue: { id: issue.iid, title: issue.title, url: issue.web_url, label: toLabel },
        research: {
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
