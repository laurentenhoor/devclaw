/**
 * task_list — Browse issues by workflow state.
 *
 * Lists issues grouped by state label with optional filtering by state type,
 * specific label, or text search. Supports terminal (closed) issues.
 */
import { jsonResult } from "openclaw/plugin-sdk";
import type { PluginContext } from "../../context.js";
import type { ToolContext } from "../../types.js";
import { log as auditLog } from "../../audit.js";
import { requireWorkspaceDir, resolveProject, resolveProvider } from "../helpers.js";
import { loadWorkflow, StateType, findStateByLabel } from "../../workflow/index.js";

export function createTaskListTool(ctx: PluginContext) {
  return (toolCtx: ToolContext) => ({
    name: "task_list",
    label: "Task List",
    description: `Browse issues for a project by workflow state. Shows issues grouped by state label. Use \`tasks_status\` for a quick dashboard overview, this tool for detailed browsing.`,
    parameters: {
      type: "object",
      required: ["projectSlug"],
      properties: {
        projectSlug: {
          type: "string",
          description: "Project slug (e.g. 'my-webapp')",
        },
        stateType: {
          type: "string",
          enum: ["queue", "active", "hold", "terminal", "all"],
          description: "Filter by state type. Defaults to all non-terminal states.",
        },
        label: {
          type: "string",
          description: "Filter by specific state label (e.g. 'Planning', 'Done'). Overrides stateType.",
        },
        search: {
          type: "string",
          description: "Text search in issue titles (case-insensitive).",
        },
        limit: {
          type: "number",
          description: "Max issues per state. Defaults to 20.",
        },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const workspaceDir = requireWorkspaceDir(toolCtx);
      const slug = (params.projectSlug ?? params.projectGroupId) as string;
      const stateType = params.stateType as string | undefined;
      const label = params.label as string | undefined;
      const search = params.search as string | undefined;
      const limit = (params.limit as number) ?? 20;

      const { project } = await resolveProject(workspaceDir, slug);
      const { provider } = await resolveProvider(project, ctx.runCommand);
      const workflow = await loadWorkflow(workspaceDir, project.name);

      // Determine which labels to fetch
      type FetchEntry = { label: string; type: string; role?: string; issueState: "open" | "closed" | "all" };
      const labelsToFetch: FetchEntry[] = [];

      if (label) {
        const stateConfig = findStateByLabel(workflow, label);
        if (!stateConfig) throw new Error(`Unknown state label "${label}". Check workflow_guide for valid states.`);
        labelsToFetch.push({
          label: stateConfig.label,
          type: stateConfig.type,
          role: stateConfig.role,
          issueState: stateConfig.type === StateType.TERMINAL ? "closed" : "open",
        });
      } else {
        const includeTerminal = stateType === "terminal" || stateType === "all";
        for (const state of Object.values(workflow.states)) {
          if (state.type === StateType.TERMINAL && !includeTerminal) continue;
          if (stateType && stateType !== "all" && state.type !== stateType) continue;
          labelsToFetch.push({
            label: state.label,
            type: state.type,
            role: state.role,
            issueState: state.type === StateType.TERMINAL ? "closed" : "open",
          });
        }
      }

      // Fetch and filter
      const searchLower = search?.toLowerCase();
      const results: Array<{
        label: string;
        type: string;
        role?: string;
        issues: Array<{ id: number; title: string; url: string }>;
        total: number;
      }> = [];

      for (const entry of labelsToFetch) {
        let issues = await provider.listIssues({ label: entry.label, state: entry.issueState }).catch(() => []);

        if (searchLower) {
          issues = issues.filter((i) => i.title.toLowerCase().includes(searchLower));
        }

        const total = issues.length;
        const limited = issues.slice(0, limit);

        results.push({
          label: entry.label,
          type: entry.type,
          role: entry.role,
          issues: limited.map((i) => ({ id: i.iid, title: i.title, url: i.web_url })),
          total,
        });
      }

      // Only include states that have issues (unless a specific label was requested)
      const nonEmpty = label ? results : results.filter((r) => r.total > 0);
      const totalIssues = results.reduce((sum, r) => sum + r.total, 0);

      await auditLog(workspaceDir, "task_list", {
        project: project.name,
        stateType: stateType ?? (label ? undefined : "non-terminal"),
        label,
        search,
        totalIssues,
      });

      return jsonResult({
        success: true,
        project: project.name,
        filter: { stateType: stateType ?? null, label: label ?? null, search: search ?? null },
        states: nonEmpty,
        totalIssues,
      });
    },
  });
}
