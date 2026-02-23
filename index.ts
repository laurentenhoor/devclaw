import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createWorkStartTool } from "./lib/tools/worker/work-start.js";
import { createWorkFinishTool } from "./lib/tools/worker/work-finish.js";
import { createTaskCreateTool } from "./lib/tools/tasks/task-create.js";
import { createTaskUpdateTool } from "./lib/tools/tasks/task-update.js";
import { createTaskCommentTool } from "./lib/tools/tasks/task-comment.js";
import { createTaskEditBodyTool } from "./lib/tools/tasks/task-edit-body.js";
import { createTasksStatusTool } from "./lib/tools/admin/tasks-status.js";
import { createHealthTool } from "./lib/tools/admin/health.js";
import { createProjectRegisterTool } from "./lib/tools/admin/project-register.js";
import { createSetupTool } from "./lib/tools/admin/setup.js";
import { createOnboardTool } from "./lib/tools/admin/onboard.js";
import { createAutoConfigureModelsTool } from "./lib/tools/admin/autoconfigure-models.js";
import { createResearchTaskTool } from "./lib/tools/worker/research-task.js";
import { createTaskListTool } from "./lib/tools/tasks/task-list.js";
import { createWorkflowGuideTool } from "./lib/tools/admin/workflow-guide.js";
import { createResetDefaultsTool } from "./lib/tools/admin/reset-defaults.js";
import { createSyncLabelsTool } from "./lib/tools/admin/sync-labels.js";
import { createUpgradeTool } from "./lib/tools/admin/upgrade.js";
import { createClaimOwnershipTool } from "./lib/tools/admin/claim-ownership.js";
import { registerCli } from "./lib/setup/cli.js";
import { registerHeartbeatService } from "./lib/services/heartbeat/index.js";
import { registerBootstrapHook } from "./lib/dispatch/bootstrap-hook.js";
import { createTaskAttachTool } from "./lib/tools/tasks/task-attach.js";
import { registerAttachmentHook } from "./lib/dispatch/attachment-hook.js";
import { createPluginContext } from "./lib/context.js";

const plugin = {
  id: "devclaw",
  name: "DevClaw",
  description:
    "Multi-project dev/qa pipeline orchestration with GitHub/GitLab integration, developer tiers, and audit logging.",
  configSchema: {
    type: "object",
    properties: {
      projectExecution: {
        type: "string",
        enum: ["parallel", "sequential"],
        description:
          "Plugin-level: parallel (each project independent) or sequential (one project at a time)",
        default: "parallel",
      },
      notifications: {
        type: "object",
        description:
          "Per-event-type notification toggles. All default to true — set to false to suppress.",
        properties: {
          workerStart: { type: "boolean", default: true },
          workerComplete: { type: "boolean", default: true },
        },
      },
      work_heartbeat: {
        type: "object",
        description:
          "Token-free interval-based heartbeat service. Runs health checks + queue dispatch automatically. Discovers all DevClaw agents from openclaw.json and processes each independently.",
        properties: {
          enabled: {
            type: "boolean",
            default: true,
            description: "Enable automatic periodic heartbeat service.",
          },
          intervalSeconds: {
            type: "number",
            default: 60,
            description: "Seconds between automatic heartbeat ticks.",
          },
          maxPickupsPerTick: {
            type: "number",
            default: 4,
            description: "Max worker dispatches per agent per tick. Applied to each DevClaw agent independently.",
          },
        },
      },
    },
  },

  register(api: OpenClawPluginApi) {
    const ctx = createPluginContext(api);

    // Worker lifecycle
    api.registerTool(createWorkStartTool(ctx), { names: ["work_start"] });
    api.registerTool(createWorkFinishTool(ctx), { names: ["work_finish"] });

    // Task management
    api.registerTool(createTaskCreateTool(ctx), { names: ["task_create"] });
    api.registerTool(createTaskUpdateTool(ctx), { names: ["task_update"] });
    api.registerTool(createTaskCommentTool(ctx), { names: ["task_comment"] });
    api.registerTool(createTaskEditBodyTool(ctx), { names: ["task_edit_body"] });
    api.registerTool(createTaskAttachTool(ctx), { names: ["task_attach"] });

    // Architect
    api.registerTool(createResearchTaskTool(ctx), { names: ["research_task"] });

    // Operations
    api.registerTool(createTasksStatusTool(ctx), { names: ["tasks_status"] });
    api.registerTool(createTaskListTool(ctx), { names: ["task_list"] });
    api.registerTool(createHealthTool(ctx), { names: ["health"] });
    // Setup & config
    api.registerTool(createProjectRegisterTool(ctx), {
      names: ["project_register"],
    });
    api.registerTool(createSetupTool(ctx), { names: ["setup"] });
    api.registerTool(createOnboardTool(ctx), { names: ["onboard"] });
    api.registerTool(createAutoConfigureModelsTool(ctx), {
      names: ["autoconfigure_models"],
    });
    api.registerTool(createWorkflowGuideTool(ctx), {
      names: ["workflow_guide"],
    });
    api.registerTool(createResetDefaultsTool(ctx), {
      names: ["reset_defaults"],
    });
    api.registerTool(createSyncLabelsTool(ctx), {
      names: ["sync_labels"],
    });
    api.registerTool(createUpgradeTool(ctx), {
      names: ["upgrade"],
    });
    api.registerTool(createClaimOwnershipTool(ctx), {
      names: ["claim_ownership"],
    });

    // CLI
    api.registerCli(({ program }: { program: any }) => registerCli(program, ctx), {
      commands: ["devclaw"],
    });

    // Services
    registerHeartbeatService(api, ctx);

    // Bootstrap hooks for worker instruction injection (hybrid: internal + lifecycle)
    registerBootstrapHook(api, ctx);
    registerAttachmentHook(api, ctx);

    api.logger.info(
      "DevClaw plugin registered (20 tools, 1 CLI command group, 1 service, 3 hooks)",
    );
  },
};

export default plugin;
