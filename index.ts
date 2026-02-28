import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createPluginContext } from "./lib/context.js";

// Worker lifecycle
import { createTaskStartTool } from "./lib/tools/tasks/task-start.js";
import { createWorkFinishTool } from "./lib/tools/worker/work-finish.js";

// Task management
import { createTaskCreateTool } from "./lib/tools/tasks/task-create.js";
import { createTaskEditBodyTool } from "./lib/tools/tasks/task-edit-body.js";
import { createTaskCommentTool } from "./lib/tools/tasks/task-comment.js";
import { createTaskAttachTool } from "./lib/tools/tasks/task-attach.js";
import { createTaskSetLevelTool } from "./lib/tools/tasks/task-set-level.js";
import { createTaskOwnerTool } from "./lib/tools/tasks/task-owner.js";
import { createResearchTaskTool } from "./lib/tools/tasks/research-task.js";

// Task queries
import { createTaskListTool } from "./lib/tools/tasks/task-list.js";
import { createTasksStatusTool } from "./lib/tools/tasks/tasks-status.js";

// Project admin
import { createProjectStatusTool } from "./lib/tools/admin/project-status.js";
import { createProjectRegisterTool } from "./lib/tools/admin/project-register.js";
import { createHealthTool } from "./lib/tools/admin/health.js";
import { createSyncLabelsTool } from "./lib/tools/admin/sync-labels.js";
import { createChannelLinkTool } from "./lib/tools/admin/channel-link.js";
import { createChannelUnlinkTool } from "./lib/tools/admin/channel-unlink.js";
import { createChannelListTool } from "./lib/tools/admin/channel-list.js";

// Setup & onboarding
import { createSetupTool } from "./lib/tools/admin/setup.js";
import { createOnboardTool } from "./lib/tools/admin/onboard.js";
import { createAutoConfigureModelsTool } from "./lib/tools/admin/autoconfigure-models.js";
import { createWorkflowGuideTool } from "./lib/tools/admin/workflow-guide.js";
import { createConfigTool } from "./lib/tools/admin/config.js";

// Infrastructure
import { registerCli } from "./lib/setup/cli.js";
import { registerHeartbeatService } from "./lib/services/heartbeat/index.js";
import { registerBootstrapHook } from "./lib/dispatch/bootstrap-hook.js";
import { registerAttachmentHook } from "./lib/dispatch/attachment-hook.js";

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
    api.registerTool(createTaskStartTool(ctx), { names: ["task_start"] });
    api.registerTool(createWorkFinishTool(ctx), { names: ["work_finish"] });

    // Task management
    api.registerTool(createTaskCreateTool(ctx), { names: ["task_create"] });
    api.registerTool(createTaskEditBodyTool(ctx), { names: ["task_edit_body"] });
    api.registerTool(createTaskCommentTool(ctx), { names: ["task_comment"] });
    api.registerTool(createTaskAttachTool(ctx), { names: ["task_attach"] });
    api.registerTool(createTaskSetLevelTool(ctx), { names: ["task_set_level"] });
    api.registerTool(createTaskOwnerTool(ctx), { names: ["task_owner"] });
    api.registerTool(createResearchTaskTool(ctx), { names: ["research_task"] });

    // Task queries
    api.registerTool(createTaskListTool(ctx), { names: ["task_list"] });
    api.registerTool(createTasksStatusTool(ctx), { names: ["tasks_status"] });

    // Project admin
    api.registerTool(createProjectStatusTool(ctx), { names: ["project_status"] });
    api.registerTool(createProjectRegisterTool(ctx), { names: ["project_register"] });
    api.registerTool(createHealthTool(ctx), { names: ["health"] });
    api.registerTool(createSyncLabelsTool(ctx), { names: ["sync_labels"] });
    api.registerTool(createChannelLinkTool(ctx), { names: ["channel_link"] });
    api.registerTool(createChannelUnlinkTool(ctx), { names: ["channel_unlink"] });
    api.registerTool(createChannelListTool(ctx), { names: ["channel_list"] });

    // Setup & onboarding
    api.registerTool(createSetupTool(ctx), { names: ["setup"] });
    api.registerTool(createOnboardTool(ctx), { names: ["onboard"] });
    api.registerTool(createAutoConfigureModelsTool(ctx), { names: ["autoconfigure_models"] });
    api.registerTool(createWorkflowGuideTool(ctx), { names: ["workflow_guide"] });
    api.registerTool(createConfigTool(ctx), { names: ["config"] });

    // CLI, services & hooks
    api.registerCli(({ program }: { program: any }) => registerCli(program, ctx), {
      commands: ["devclaw"],
    });
    registerHeartbeatService(api, ctx);
    registerBootstrapHook(api, ctx);
    registerAttachmentHook(api, ctx);

    api.logger.info(
      "DevClaw plugin registered (23 tools, 1 CLI command group, 1 service, 3 hooks)",
    );
  },
};

export default plugin;
