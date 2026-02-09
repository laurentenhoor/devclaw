import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createTaskPickupTool } from "./lib/tools/task-pickup.js";
import { createTaskCompleteTool } from "./lib/tools/task-complete.js";
import { createQueueStatusTool } from "./lib/tools/queue-status.js";
import { createSessionHealthTool } from "./lib/tools/session-health.js";
import { createProjectRegisterTool } from "./lib/tools/project-register.js";
import { createTaskCreateTool } from "./lib/tools/task-create.js";
import { createSetupTool } from "./lib/tools/devclaw-setup.js";
import { createOnboardTool } from "./lib/tools/devclaw-onboard.js";
import { createAnalyzeChannelBindingsTool } from "./lib/tools/analyze-channel-bindings.js";
import { createContextTestTool } from "./lib/tools/context-test.js";
import { registerCli } from "./lib/cli.js";

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
        description: "Model mapping per developer tier",
        properties: {
          junior: { type: "string", description: "Junior dev model" },
          medior: { type: "string", description: "Medior dev model" },
          senior: { type: "string", description: "Senior dev model" },
          qa: { type: "string", description: "QA engineer model" },
        },
      },
    },
  },

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
    api.registerTool(createSetupTool(api), {
      names: ["devclaw_setup"],
    });
    api.registerTool(createOnboardTool(api), {
      names: ["devclaw_onboard"],
    });
    api.registerTool(createAnalyzeChannelBindingsTool(api), {
      names: ["analyze_channel_bindings"],
    });
    api.registerTool(createContextTestTool(api), {
      names: ["context_test"],
    });

    // CLI: `openclaw devclaw setup`
    api.registerCli(({ program }: { program: any }) => registerCli(program), {
      commands: ["devclaw"],
    });

    api.logger.info(
      "DevClaw plugin registered (10 tools, 1 CLI command)",
    );
  },
};

export default plugin;
