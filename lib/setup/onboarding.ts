/**
 * onboarding.ts — Conversational onboarding context templates.
 *
 * Provides context templates for the onboard tool.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getAllDefaultModels } from "../roles/index.js";

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export function isPluginConfigured(
  pluginConfig?: Record<string, unknown>,
): boolean {
  // Models moved to workflow.yaml — check for any devclaw plugin config (heartbeat, notifications, etc.)
  return !!pluginConfig && Object.keys(pluginConfig).length > 0;
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
    return content.includes("DevClaw") && (content.includes("task_start") || content.includes("work_start"));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Context templates
// ---------------------------------------------------------------------------

function buildModelTable(): string {
  const lines: string[] = [];
  for (const [role, levels] of Object.entries(getAllDefaultModels())) {
    for (const [level, model] of Object.entries(levels)) {
      lines.push(`  - **${role} ${level}**: ${model}`);
    }
  }
  return lines.join("\n");
}

export function buildReconfigContext(): string {
  const modelTable = buildModelTable();
  return `# DevClaw Reconfiguration

The user wants to reconfigure DevClaw. Default model configuration:

${modelTable}

Models are configured in \`devclaw/workflow.yaml\`. Edit that file directly or call \`setup\` with a \`models\` object to update.

## What can be changed
1. **Model levels** — call \`setup\` with a \`models\` object containing only the levels to change
2. **Workspace files** — \`setup\` re-writes AGENTS.md, HEARTBEAT.md (backs up existing files)
3. **Register new projects** — use \`project_register\`

Ask what they want to change, then call the appropriate tool.
\`setup\` is safe to re-run — it backs up existing files before overwriting.
`;
}

export function buildOnboardToolContext(): string {
  // Build the model table dynamically from getAllDefaultModels()
  const rows: string[] = [];
  const purposes: Record<string, string> = {
    junior: "Simple tasks, single-file fixes",
    medior: "Features, bug fixes, code review",
    senior: "Architecture, refactoring, complex tasks",
  };
  for (const [role, levels] of Object.entries(getAllDefaultModels())) {
    for (const [level, model] of Object.entries(levels)) {
      rows.push(`| ${role} | ${level} | ${model} | ${purposes[level] ?? ""} |`);
    }
  }
  const modelTable = rows.join("\n");

  return `# DevClaw Onboarding

## What is DevClaw?
DevClaw turns each Telegram group into an autonomous development team:
- An **orchestrator** that manages backlogs and delegates work
- **Developer workers** (junior/medior/senior levels) that write code in isolated sessions
- **Tester workers** that review code and run tests
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

1. **Call \`autoconfigure_models\`** to automatically discover and assign models:
   - Discovers all authenticated models in OpenClaw
   - Uses AI to intelligently assign them to DevClaw roles
   - Returns a ready-to-use model configuration

2. **Handle the result**:
   - If \`success: false\` and \`modelCount: 0\`:
     - **BLOCK setup** - show the authentication instructions from the message
     - **DO NOT proceed** - exit onboarding until user configures API keys
   - If \`success: true\`:
     - Present the model assignment table to the user
     - Store the \`models\` object for Step 3

3. **Optional: Prefer specific provider**
   - If user wants only models from one provider (e.g., "only use Anthropic"):
   - Call \`autoconfigure_models({ preferProvider: "anthropic" })\`

4. **Confirm with user**
   - Ask: "Does this look good, or would you like to customize any roles?"
   - If approved → proceed to Step 3 with the \`models\` configuration
   - If they want changes → ask which specific roles to modify
   - If they want different provider → go back to step 3

**Step 3: Run Setup**
Call \`setup\` with the collected answers:
- Current agent: \`setup({})\` or \`setup({ models: { developer: { ... }, tester: { ... } } })\`
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
Explain that projects should be registered **from within their Telegram group**:

📌 **How to register a project:**
1. Create a Telegram group for the project
2. Add the bot to the group
3. In that group, tell the bot: "Register this project" (or use \`project_register\`)
4. The bot will auto-detect the group ID from the conversation context

This keeps each project's registration tied to its group from the start.

You can also register a project from this admin session if you want, but it's better to keep this session free for general admin tasks. If they want to register here anyway, collect: project name, repo path, Telegram group ID, group name, base branch, then call \`project_register\`.

**Step 6: Workflow Overview**
After project registration, briefly tell the user about their active workflow:

- **Review policy**: human (default) — PRs need human approval on GitHub/GitLab, heartbeat auto-merges when approved.
- **Test phase**: skipped by default — the testing step is in the workflow but issues bypass it automatically. To enable testing for a specific issue, remove the \`test:skip\` label. To enable globally, set \`testPolicy: agent\` in workflow.yaml.
- **Customization**: They can change the review policy (human/agent/auto), enable testing (testPolicy: agent), or override settings per project. Point them to \`workflow.yaml\` in the devclaw data directory.
- Say: "Your workflow is set up with **human review** and **testing skipped** by default. You can enable testing per-issue by removing the \`test:skip\` label, or globally by setting \`testPolicy: agent\` in your workflow.yaml."

## Guidelines
- Be conversational and friendly. Ask one question at a time.
- Show defaults so the user can accept them quickly.
- After setup, summarize what was configured (including channel binding if applicable).
`;
}
