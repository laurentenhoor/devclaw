/**
 * context-guard.ts — Detect interaction context and provide guardrails.
 *
 * DevClaw should respond differently based on how it's being contacted:
 * 1. Via another agent (setup/onboarding) - guide to onboard/setup
 * 2. Direct to DevClaw agent (status queries) - use status
 * 3. Via Telegram group (project work) - use work_start, work_finish, task_create
 */
import type { ToolContext } from "./types.js";
import fs from "node:fs/promises";
import path from "node:path";

export type InteractionContext =
  | { type: "via-agent"; agentId: string; agentName?: string }
  | { type: "direct"; channel?: string; chatId?: string }
  | {
      type: "group";
      channel: string;
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
        channel: messageChannel,
        groupId: actualGroupId,
        projectName,
      };
    }
  }

  // --- Direct (DM or CLI) ---
  // Extract chat ID from sessionKey (e.g. "agent:devclaw:telegram:direct:657120585")
  const chatId = sessionKey ? sessionKey.split(":").pop() : undefined;
  return {
    type: "direct",
    channel: messageChannel ?? "cli",
    chatId,
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
- If the user mentions "setup", "install", "configure", or "onboard" → call \`onboard\` first
- Then follow the guidance to call \`setup\` with collected answers
- After setup, offer to register a project via \`project_register\`

**What to avoid:**
- Don't discuss ongoing development tasks (those happen in group chats)
- Don't use work_start/work_finish/status (not relevant during setup)
`;

    case "direct":
      return `## 🛡️ Context: Direct Communication (${context.channel})

You're in a **direct message** with the DevClaw agent (not a project group).

**What you should do:**
- Provide **general status** via \`status\` (across all projects)
- Answer questions about DevClaw configuration
- Guide to project-specific work: "For project tasks, please message the relevant Telegram/WhatsApp group"

**What to avoid:**
- Don't start development tasks here (use \`work_start\` only in project groups)
- Don't discuss project-specific issues (redirect to the group)
`;

    case "group":
      return `## 🛡️ Context: Project Group Chat (${context.channel})

You're in a **Telegram/WhatsApp group** bound to ${context.projectName ? `project **${context.projectName}**` : "a project"}.

**What you should do:**
- Handle task lifecycle: \`work_start\` (start work), \`work_finish\` (finish)
- Create new issues via \`task_create\`
- Check this project's queue via \`status\`
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
