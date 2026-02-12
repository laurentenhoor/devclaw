/**
 * onboarding.ts — Conversational onboarding context templates.
 *
 * Provides context templates for the onboard tool.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_MODELS } from "./tiers.js";

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export function isPluginConfigured(
  pluginConfig?: Record<string, unknown>,
): boolean {
  const models = (pluginConfig as { models?: Record<string, string> })?.models;
  return !!models && Object.keys(models).length > 0;
}

export async function hasWorkspaceFiles(
  workspaceDir?: string,
): Promise<boolean> {
  if (!workspaceDir) return false;
  try {
    const content = await fs.readFile(
      path.join(workspaceDir, "AGENTS.md"),
      "utf-8",
    );
    return content.includes("DevClaw") && content.includes("work_start");
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Context templates
// ---------------------------------------------------------------------------

function buildModelTable(pluginConfig?: Record<string, unknown>): string {
  const cfg = (pluginConfig as { models?: { dev?: Record<string, string>; qa?: Record<string, string> } })?.models;
  const lines: string[] = [];
  for (const [role, levels] of Object.entries(DEFAULT_MODELS)) {
    for (const [level, defaultModel] of Object.entries(levels)) {
      const model = cfg?.[role as "dev" | "qa"]?.[level] || defaultModel;
      lines.push(`  - **${role} ${level}**: ${model} (default: ${defaultModel})`);
    }
  }
  return lines.join("\n");
}

export function buildReconfigContext(
  pluginConfig?: Record<string, unknown>,
): string {
  const modelTable = buildModelTable(pluginConfig);
  return `# DevClaw Reconfiguration

The user wants to reconfigure DevClaw. Current model configuration:

${modelTable}

## What can be changed
1. **Model levels** — call \`setup\` with a \`models\` object containing only the levels to change
2. **Workspace files** — \`setup\` re-writes AGENTS.md, HEARTBEAT.md (backs up existing files)
3. **Register new projects** — use \`project_register\`

Ask what they want to change, then call the appropriate tool.
\`setup\` is safe to re-run — it backs up existing files before overwriting.
`;
}

export function buildOnboardToolContext(): string {
  // Build the model table dynamically from DEFAULT_MODELS
  const rows: string[] = [];
  const purposes: Record<string, string> = {
    junior: "Typos, single-file fixes",
    medior: "Features, bug fixes",
    senior: "Architecture, refactoring",
    reviewer: "Code review",
    tester: "Testing",
  };
  for (const [role, levels] of Object.entries(DEFAULT_MODELS)) {
    for (const [level, model] of Object.entries(levels)) {
      rows.push(`| ${role} | ${level} | ${model} | ${purposes[level] ?? ""} |`);
    }
  }
  const modelTable = rows.join("\n");

  return `# DevClaw Onboarding

## What is DevClaw?
DevClaw turns each Telegram group into an autonomous development team:
- An **orchestrator** that manages backlogs and delegates work
- **DEV workers** (junior/medior/senior levels) that write code in isolated sessions
- **QA workers** that review code and run tests
- Atomic tools for label transitions, session dispatch, state management, and audit logging

## Setup Steps

**Step 1: Agent Selection**
Ask: "Do you want to configure DevClaw for the current agent, or create a new dedicated agent?"
- Current agent → no \`newAgentName\` needed
- New agent → ask for:
  1. Agent name
  2. **Channel binding**: "Which channel should this agent listen to? (telegram/whatsapp/none)"
     - If telegram/whatsapp selected:
       a) Check openclaw.json for existing channel bindings
       b) If channel not configured/enabled → warn and recommend skipping binding for now
       c) If channel-wide binding exists on another agent → ask: "Migrate binding from {agentName}?"
       d) Collect migration decision
     - If none selected, user can add bindings manually later via openclaw.json

**Step 2: Model Configuration**
⚠️ **IMPORTANT**: First check what models the user has access to! The defaults below are suggestions.

Ask: "What models do you have access to in your OpenClaw configuration?"
- Guide them to check their available models (router configuration, API keys, etc.)
- If they have the default Claude models, great!
- If not, help them map their available models to these levels:

**Suggested default level-to-model mapping:**

| Role | Level | Default Model | Purpose |
|------|-------|---------------|---------|
${modelTable}

**Model selection guidance:**
- **junior/tester**: Fastest, cheapest models (Haiku-class, GPT-4-mini, etc.)
- **medior/reviewer**: Balanced models (Sonnet-class, GPT-4, etc.)
- **senior**: Most capable models (Opus-class, o1, etc.)

Ask which levels they want to customize, and collect their actual model IDs.
💡 **Tip**: Guide users to configure finer-grained mappings rather than accepting unsuitable defaults.

**Step 3: Run Setup**
Call \`setup\` with the collected answers:
- Current agent: \`setup({})\` or \`setup({ models: { dev: { ... }, qa: { ... } } })\`
- New agent: \`setup({ newAgentName: "<name>", channelBinding: "telegram"|"whatsapp"|null, migrateFrom: "<agentId>"|null, models: { ... } })\`
  - \`migrateFrom\`: Include if user wants to migrate an existing channel-wide binding

**Step 4: Telegram Group Setup (IMPORTANT)**
After setup completes, explain project isolation best practices:

📱 **Telegram Group Guidance:**
DevClaw uses **one Telegram group per project** for isolation and clean backlogs.

**Recommended Setup:**
1. **Create a new Telegram group** for each project
2. **Add your bot** to the group
3. **Use mentions** to interact: "@botname status", "@botname pick up #42"
4. Each group gets its own queue, workers, and audit log

**Why separate groups?**
- Clean issue backlogs per project
- Isolated worker state (no cross-project confusion)
- Clear audit trails
- Team-specific access control

**Single-project mode:**
If you REALLY want all projects in one group (not recommended):
- You can register multiple projects to the same group ID
- ⚠️ WARNING: Shared queues, workers will see all issues
- Only use this for personal/solo projects

Ask: "Do you understand the group-per-project model, or do you want single-project mode?"
- Most users should proceed with the recommended approach
- Only force single-project if they insist

**Step 5: Project Registration**
Ask: "Would you like to register a project now?"
If yes, collect: project name, repo path, Telegram group ID, group name, base branch.
Then call \`project_register\`.

💡 **Tip**: For the Telegram group ID:
- Add the bot to your group
- Send any message with the bot mentioned
- Bot can tell you the group ID

## Guidelines
- Be conversational and friendly. Ask one question at a time.
- Show defaults so the user can accept them quickly.
- After setup, summarize what was configured (including channel binding if applicable).
`;
}
