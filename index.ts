import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createTaskPickupTool } from "./lib/tools/task-pickup.js";
import { createTaskCompleteTool } from "./lib/tools/task-complete.js";
import { createQueueStatusTool } from "./lib/tools/queue-status.js";
import { createSessionHealthTool } from "./lib/tools/session-health.js";
import { createProjectRegisterTool } from "./lib/tools/project-register.js";
import { createTaskCreateTool } from "./lib/tools/task-create.js";

const plugin = {
  id: "devclaw",
  name: "DevClaw",
  description:
    "Multi-project dev/qa pipeline orchestration with GitHub/GitLab integration, model selection, and audit logging.",
  configSchema: {},

  register(api: OpenClawPluginApi) {
    // Agent tools (primary interface — agent calls these directly)
    api.registerTool(createTaskPickupTool(api), {
      names: ["task_pickup"],
    });
    api.registerTool(createTaskCompleteTool(api), {
      names: ["task_complete"],
    });
    api.registerTool(createQueueStatusTool(api), {
      names: ["queue_status"],
    });
    api.registerTool(createSessionHealthTool(api), {
      names: ["session_health"],
    });
    api.registerTool(createProjectRegisterTool(api), {
      names: ["project_register"],
    });
    api.registerTool(createTaskCreateTool(api), {
      names: ["task_create"],
    });

    api.logger.info("DevClaw plugin registered (6 tools)");
  },
};

export default plugin;
