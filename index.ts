import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createWorkStartTool } from "./lib/tools/work-start.js";
import { createWorkFinishTool } from "./lib/tools/work-finish.js";
import { createTaskCreateTool } from "./lib/tools/task-create.js";
import { createTaskUpdateTool } from "./lib/tools/task-update.js";
import { createTaskCommentTool } from "./lib/tools/task-comment.js";
import { createStatusTool } from "./lib/tools/status.js";
import { createHealthTool } from "./lib/tools/health.js";
import { createWorkHeartbeatTool } from "./lib/tools/work-heartbeat.js";
import { createProjectRegisterTool } from "./lib/tools/project-register.js";
import { createSetupTool } from "./lib/tools/setup.js";
import { createOnboardTool } from "./lib/tools/onboard.js";
import { registerCli } from "./lib/cli.js";
import { registerHeartbeatService } from "./lib/services/heartbeat.js";

const plugin = {
  id: "devclaw",
  name: "DevClaw",
  description:
    "Multi-project dev/qa pipeline orchestration with GitHub/GitLab integration, developer tiers, and audit logging.",
  configSchema: {
    type: "object",
    properties: {
      models: {
        type: "object",
        description: "Model mapping per role and tier",
        properties: {
          dev: {
            type: "object",
            description: "Developer tier models",
            properties: {
              junior: { type: "string" },
              medior: { type: "string" },
              senior: { type: "string" },
            },
          },
          qa: {
            type: "object",
            description: "QA tier models",
            properties: {
              "qa-engineer": { type: "string" },
              "manual-tester": { type: "string" },
            },
          },
        },
      },
      projectExecution: {
        type: "string",
        enum: ["parallel", "sequential"],
        description: "Plugin-level: parallel (each project independent) or sequential (one project at a time)",
        default: "parallel",
      },
      notifications: {
        type: "object",
        description: "Notification settings",
        properties: {
          heartbeatDm: { type: "boolean", default: true },
          workerStart: { type: "boolean", default: true },
          workerComplete: { type: "boolean", default: true },
        },
      },
      work_heartbeat: {
        type: "object",
        description: "Token-free interval-based heartbeat service. Runs health checks + queue dispatch automatically.",
        properties: {
          enabled: { type: "boolean", default: true, description: "Enable the heartbeat service." },
          intervalSeconds: { type: "number", default: 60, description: "Seconds between ticks." },
          maxPickupsPerTick: { type: "number", default: 4, description: "Max worker dispatches per tick." },
        },
      },
    },
  },

  register(api: OpenClawPluginApi) {
    // Worker lifecycle
    api.registerTool(createWorkStartTool(api), { names: ["work_start"] });
    api.registerTool(createWorkFinishTool(api), { names: ["work_finish"] });

    // Task management
    api.registerTool(createTaskCreateTool(api), { names: ["task_create"] });
    api.registerTool(createTaskUpdateTool(api), { names: ["task_update"] });
    api.registerTool(createTaskCommentTool(api), { names: ["task_comment"] });

    // Operations
    api.registerTool(createStatusTool(api), { names: ["status"] });
    api.registerTool(createHealthTool(api), { names: ["health"] });
    api.registerTool(createWorkHeartbeatTool(api), { names: ["work_heartbeat"] });

    // Setup & config
    api.registerTool(createProjectRegisterTool(api), { names: ["project_register"] });
    api.registerTool(createSetupTool(api), { names: ["setup"] });
    api.registerTool(createOnboardTool(api), { names: ["onboard"] });

    // CLI
    api.registerCli(({ program }: { program: any }) => registerCli(program), {
      commands: ["devclaw"],
    });

    // Services
    registerHeartbeatService(api);

    api.logger.info("DevClaw plugin registered (11 tools, 1 service, 1 CLI command)");
  },
};

export default plugin;
