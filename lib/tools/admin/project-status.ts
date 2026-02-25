/**
 * project_status — Instant local project info for the current channel.
 *
 * Returns project registration, channel bindings, worker slot states,
 * workflow config, and execution settings. No issue-tracker API calls.
 * Use `tasks_status` for live issue counts.
 */
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../../types.js";
import type { PluginContext } from "../../context.js";
import { requireWorkspaceDir, resolveChannelId, resolveProject } from "../helpers.js";
import { ExecutionMode, StateType } from "../../workflow/index.js";
import { loadConfig } from "../../config/index.js";
import { loadInstanceName } from "../../instance.js";

export function createProjectStatusTool(ctx: PluginContext) {
  return (toolCtx: ToolContext) => ({
    name: "project_status",
    label: "Project Status",
    description:
      "Instant project info for this channel: registration, channels, worker slots, workflow, and config. " +
      "No API calls — all local data. Use `tasks_status` for live issue counts from the issue tracker.",
    parameters: {
      type: "object",
      required: ["channelId"],
      properties: {
        channelId: {
          type: "string",
          description: "YOUR chat/group ID — the numeric ID of the chat you are in right now (e.g. '-1003844794417'). Do NOT guess; use the ID of the conversation this message came from.",
        },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const workspaceDir = requireWorkspaceDir(toolCtx);
      const channelId = resolveChannelId(toolCtx, params.channelId as string | undefined);

      const { project } = await resolveProject(workspaceDir, channelId);

      const pluginConfig = ctx.pluginConfig;
      const projectExecution = (pluginConfig?.projectExecution as string) ?? ExecutionMode.PARALLEL;

      const projectConfig = await loadConfig(workspaceDir, project.name);
      const workflow = projectConfig.workflow;
      const instanceName = await loadInstanceName(workspaceDir, projectConfig.instanceName);

      // Workers summary - per-level slot utilization
      const workers: Record<string, {
        levelMaxWorkers: Record<string, number>;
        activeSlots: number;
        levels: Record<string, Array<{ active: boolean; issueId: string | null; startTime: string | null }>>;
      }> = {};
      for (const [role, rw] of Object.entries(project.workers)) {
        const levelMaxWorkers = projectConfig.roles[role]?.levelMaxWorkers ?? {};
        let activeSlots = 0;
        const levels: Record<string, Array<{ active: boolean; issueId: string | null; startTime: string | null }>> = {};
        for (const [level, slots] of Object.entries(rw.levels)) {
          levels[level] = slots.map(slot => ({
            active: slot.active,
            issueId: slot.issueId,
            startTime: slot.startTime,
          }));
          activeSlots += slots.filter(s => s.active).length;
        }
        workers[role] = { levelMaxWorkers, activeSlots, levels };
      }

      // Workflow summary
      const hasTestPhase = Object.values(workflow.states).some(
        (s) => s.role === "tester" && (s.type === StateType.QUEUE || s.type === StateType.ACTIVE),
      );
      const workflowSummary = {
        reviewPolicy: workflow.reviewPolicy ?? "human",
        roleExecution: workflow.roleExecution ?? ExecutionMode.PARALLEL,
        testPhase: hasTestPhase,
        stateFlow: Object.entries(workflow.states)
          .map(([, s]) => s.label)
          .join(" → "),
      };

      return jsonResult({
        success: true,
        instanceName,
        execution: { projectExecution },
        project: {
          name: project.name,
          slug: project.slug,
          repo: project.repo,
          provider: project.provider,
          baseBranch: project.baseBranch,
          deployBranch: project.deployBranch,
          channels: project.channels,
        },
        workflow: workflowSummary,
        workers,
      });
    },
  });
}
