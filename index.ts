import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createWorkStartTool } from "./lib/tools/work-start.js";
import { createWorkFinishTool } from "./lib/tools/work-finish.js";
import { createTaskCreateTool } from "./lib/tools/task-create.js";
import { createTaskUpdateTool } from "./lib/tools/task-update.js";
import { createTaskCommentTool } from "./lib/tools/task-comment.js";
import { createStatusTool } from "./lib/tools/status.js";
import { createHealthTool } from "./lib/tools/health.js";
import { createProjectRegisterTool } from "./lib/tools/project-register.js";
import { createSetupTool } from "./lib/tools/setup.js";
import { createOnboardTool } from "./lib/tools/onboard.js";
import { createAutoConfigureModelsTool } from "./lib/tools/autoconfigure-models.js";
import { createDesignTaskTool } from "./lib/tools/design-task.js";
import { registerCli } from "./lib/cli.js";
import { registerHeartbeatService } from "./lib/services/heartbeat.js";
import { registerBootstrapHook } from "./lib/bootstrap-hook.js";
import { initRunCommand } from "./lib/run-command.js";

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
    initRunCommand(api);

    // Worker lifecycle
    api.registerTool(createWorkStartTool(api), { names: ["work_start"] });
    api.registerTool(createWorkFinishTool(api), { names: ["work_finish"] });

    // Task management
    api.registerTool(createTaskCreateTool(api), { names: ["task_create"] });
    api.registerTool(createTaskUpdateTool(api), { names: ["task_update"] });
    api.registerTool(createTaskCommentTool(api), { names: ["task_comment"] });

    // Architect
    api.registerTool(createDesignTaskTool(api), { names: ["design_task"] });

    // Operations
    api.registerTool(createStatusTool(api), { names: ["status"] });
    api.registerTool(createHealthTool(), { names: ["health"] });
    // Setup & config
    api.registerTool(createProjectRegisterTool(), {
      names: ["project_register"],
    });
    api.registerTool(createSetupTool(api), { names: ["setup"] });
    api.registerTool(createOnboardTool(api), { names: ["onboard"] });
    api.registerTool(createAutoConfigureModelsTool(api), {
      names: ["autoconfigure_models"],
    });

    // CLI
    api.registerCli(({ program }: { program: any }) => registerCli(program, api), {
      commands: ["devclaw"],
    });

    // Services
    registerHeartbeatService(api);

    // Bootstrap hook for worker instruction injection
    registerBootstrapHook(api);

    api.logger.info(
      "DevClaw plugin registered (12 tools, 1 CLI command group, 1 service, 1 hook)",
    );
  },
};

export default plugin;
