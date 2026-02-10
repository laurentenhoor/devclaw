/**
 * onboarding.ts — Conversational onboarding context templates.
 *
 * Provides context templates for the onboard tool.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { ALL_TIERS, DEFAULT_MODELS, type Tier } from "./tiers.js";

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
  const models =
    (pluginConfig as { models?: Record<string, string> })?.models ?? {};
  return ALL_TIERS.map(
    (t) =>
      `  - **${t}**: ${models[t] || DEFAULT_MODELS[t as Tier]} (default: ${DEFAULT_MODELS[t as Tier]})`,
  ).join("\n");
}

export function buildReconfigContext(
  pluginConfig?: Record<string, unknown>,
): string {
  const modelTable = buildModelTable(pluginConfig);
  return `# DevClaw Reconfiguration

The user wants to reconfigure DevClaw. Current model configuration:

${modelTable}

## What can be changed
1. **Model tiers** — call \`setup\` with a \`models\` object containing only the tiers to change
2. **Workspace files** — \`setup\` re-writes AGENTS.md, HEARTBEAT.md (backs up existing files)
3. **Register new projects** — use \`project_register\`

Ask what they want to change, then call the appropriate tool.
\`setup\` is safe to re-run — it backs up existing files before overwriting.
`;
}

export function buildOnboardToolContext(): string {
  return `# DevClaw Onboarding

## What is DevClaw?
DevClaw turns each Telegram group into an autonomous development team:
- An **orchestrator** that manages backlogs and delegates work
- **DEV workers** (junior/medior/senior tiers) that write code in isolated sessions
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
Show the default tier-to-model mapping and ask if they want to customize:

| Tier | Default Model | Purpose |
|------|---------------|---------|
| junior | anthropic/claude-haiku-4-5 | Typos, single-file fixes |
| medior | anthropic/claude-sonnet-4-5 | Features, bug fixes |
| senior | anthropic/claude-opus-4-5 | Architecture, refactoring |
| qa | anthropic/claude-sonnet-4-5 | Code review, testing |

If the defaults are fine, proceed. If customizing, ask which tiers to change.

**Step 3: Run Setup**
Call \`setup\` with the collected answers:
- Current agent: \`setup({})\` or \`setup({ models: { ... } })\`
- New agent: \`setup({ newAgentName: "<name>", channelBinding: "telegram"|"whatsapp"|null, migrateFrom: "<agentId>"|null, models: { ... } })\`
  - \`migrateFrom\`: Include if user wants to migrate an existing channel-wide binding

**Step 4: Optional Project Registration**
After setup, ask: "Would you like to register a project now?"
If yes, collect: project name, repo path, Telegram group ID, group name, base branch.
Then call \`project_register\`.

## Guidelines
- Be conversational and friendly. Ask one question at a time.
- Show defaults so the user can accept them quickly.
- After setup, summarize what was configured (including channel binding if applicable).
`;
}
