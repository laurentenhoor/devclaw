/**
 * context-guard.ts — Detect interaction context and provide guardrails.
 *
 * DevClaw should respond differently based on how it's being contacted:
 * 1. Via another agent (setup/onboarding) - guide to devclaw_onboard/devclaw_setup
 * 2. Direct to DevClaw agent (status queries) - use queue_status, session_health
 * 3. Via Telegram group (project work) - use task_pickup, task_complete, task_create
 */
import type { ToolContext } from "./types.js";
import fs from "node:fs/promises";
import path from "node:path";

export type InteractionContext =
  | { type: "via-agent"; agentId: string; agentName?: string }
  | { type: "direct"; channel?: "telegram" | "whatsapp" | "cli" }
  | {
      type: "group";
      channel: "telegram" | "whatsapp";
      groupId: string;
      projectName?: string;
    };

/**
 * Detect the interaction context from ToolContext.
 *
 * Logic:
 * - If agentId doesn't match a known DevClaw agent → via-agent
 * - If messageChannel + sessionKey contains group ID → group
 * - Otherwise → direct
 */
export async function detectContext(
  ctx: ToolContext,
  devClawAgentIds: string[],
): Promise<InteractionContext> {
  const { agentId, messageChannel, sessionKey } = ctx;

  // --- Via another agent (not DevClaw) ---
  if (agentId && !devClawAgentIds.includes(agentId)) {
    return {
      type: "via-agent",
      agentId,
      // agentName could be resolved from openclaw.json if needed
    };
  }

  // --- Group chat (has messageChannel + group-like sessionKey) ---
  if (messageChannel && sessionKey) {
    // sessionKey format: "agent:{agentId}:{channel}:{type}:{groupId}"
    // Examples:
    // - Telegram: "agent:devclaw:telegram:group:-5266044536"
    // - WhatsApp: "agent:devclaw:whatsapp:group:120363123@g.us"
    const isGroupLike = sessionKey.includes(":group:");

    if (isGroupLike) {
      // Extract the actual group ID (last component after splitting)
      const parts = sessionKey.split(":");
      const actualGroupId = parts[parts.length - 1];

      // Try to match with a registered project
      const projectName = await findProjectByGroupId(
        actualGroupId,
        ctx.workspaceDir,
      );

      return {
        type: "group",
        channel: messageChannel as "telegram" | "whatsapp",
        groupId: actualGroupId,
        projectName,
      };
    }
  }

  // --- Direct (DM or CLI) ---
  return {
    type: "direct",
    channel: messageChannel
      ? (messageChannel as "telegram" | "whatsapp")
      : "cli",
  };
}

/**
 * Generate guardrail guidance based on context.
 *
 * Returns a message to prepend to tool results or inject into system context.
 */
export function generateGuardrails(context: InteractionContext): string {
  switch (context.type) {
    case "via-agent":
      return `## 🛡️ Context: Setup Mode (via ${context.agentId})

You're being called by another agent. This is likely a **setup or onboarding** scenario.

**What you should do:**
- If the user mentions "setup", "install", "configure", or "onboard" → call \`devclaw_onboard\` first
- Then follow the guidance to call \`devclaw_setup\` with collected answers
- After setup, offer to register a project via \`project_register\`

**What to avoid:**
- Don't discuss ongoing development tasks (those happen in group chats)
- Don't use task_pickup/task_complete/queue_status (not relevant during setup)
`;

    case "direct":
      return `## 🛡️ Context: Direct Communication (${context.channel})

You're in a **direct message** with the DevClaw agent (not a project group).

**What you should do:**
- Provide **general status** via \`queue_status\` (across all projects)
- Check system health via \`session_health\`
- Answer questions about DevClaw configuration
- Guide to project-specific work: "For project tasks, please message the relevant Telegram/WhatsApp group"

**What to avoid:**
- Don't start development tasks here (use \`task_pickup\` only in project groups)
- Don't discuss project-specific issues (redirect to the group)
`;

    case "group":
      return `## 🛡️ Context: Project Group Chat (${context.channel})

You're in a **Telegram/WhatsApp group** bound to ${context.projectName ? `project **${context.projectName}**` : "a project"}.

**What you should do:**
- Handle task lifecycle: \`task_pickup\` (start work), \`task_complete\` (finish)
- Create new issues via \`task_create\`
- Check this project's queue via \`queue_status\` (with projectName filter)
- Discuss implementation details, code reviews, bugs

**What to avoid:**
- Don't discuss DevClaw setup (that's for direct DMs or via another agent)
- Don't show status for unrelated projects (focus on this group's project)
`;

    default:
      return "";
  }
}

/**
 * Find project name by matching groupId in memory/projects.json.
 * The groupId (Telegram or WhatsApp) is the KEY in the projects Record.
 */
async function findProjectByGroupId(
  groupId: string,
  workspaceDir?: string,
): Promise<string | undefined> {
  if (!workspaceDir) return undefined;

  try {
    const projectsPath = path.join(workspaceDir, "memory", "projects.json");
    const raw = await fs.readFile(projectsPath, "utf-8");
    const data = JSON.parse(raw) as {
      projects: Record<string, { name: string }>;
    };

    // groupId IS the key in the Record
    return data.projects[groupId]?.name;
  } catch {
    // File doesn't exist or parse error
  }

  return undefined;
}
