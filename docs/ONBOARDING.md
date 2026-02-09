# DevClaw — Onboarding Guide

## What you need before starting

| Requirement | Why | How to check |
|---|---|---|
| [OpenClaw](https://openclaw.ai) installed | DevClaw is an OpenClaw plugin | `openclaw --version` |
| Node.js >= 20 | Runtime for plugin | `node --version` |
| [`glab`](https://gitlab.com/gitlab-org/cli) or [`gh`](https://cli.github.com) CLI | Issue tracker provider (auto-detected from remote) | `glab --version` or `gh --version` |
| CLI authenticated | Plugin calls glab/gh for every label transition | `glab auth status` or `gh auth status` |
| A GitLab/GitHub repo with issues | The task backlog lives in the issue tracker | `glab issue list` or `gh issue list` from your repo |

## Setup

### 1. Install the plugin

```bash
# Copy to extensions directory (auto-discovered on next restart)
cp -r devclaw ~/.openclaw/extensions/
```

Verify:
```bash
openclaw plugins list
# Should show: DevClaw | devclaw | loaded
```

### 2. Run setup

There are three ways to set up DevClaw:

#### Option A: Conversational onboarding (recommended)

Call the `devclaw_onboard` tool from any agent that has the DevClaw plugin loaded. The agent will walk you through configuration step by step — asking about:
- Agent selection (current or create new)
- Channel binding (telegram/whatsapp/none) — for new agents only
- Model tiers (accept defaults or customize)
- Optional project registration

The tool returns instructions that guide the agent through the QA-style setup conversation.

#### Option B: CLI wizard

```bash
openclaw devclaw setup
```

The setup wizard walks you through:

1. **Agent** — Create a new orchestrator agent or configure an existing one
2. **Developer team** — Choose which LLM model powers each developer tier:
   - **Junior** (fast, cheap tasks) — default: `anthropic/claude-haiku-4-5`
   - **Medior** (standard tasks) — default: `anthropic/claude-sonnet-4-5`
   - **Senior** (complex tasks) — default: `anthropic/claude-opus-4-5`
   - **QA** (code review) — default: `anthropic/claude-sonnet-4-5`
3. **Workspace** — Writes AGENTS.md, HEARTBEAT.md, role templates, and initializes memory

Non-interactive mode:
```bash
# Create new agent with default models
openclaw devclaw setup --new-agent "My Dev Orchestrator"

# Configure existing agent with custom models
openclaw devclaw setup --agent my-orchestrator \
  --junior "anthropic/claude-haiku-4-5" \
  --senior "anthropic/claude-opus-4-5"
```

#### Option C: Tool call (agent-driven)

**Conversational onboarding via tool:**
```json
devclaw_onboard({ mode: "first-run" })
```

The tool returns step-by-step instructions that guide the agent through the QA-style setup conversation.

**Direct setup (skip conversation):**
```json
{
  "newAgentName": "My Dev Orchestrator",
  "channelBinding": "telegram",
  "models": {
    "junior": "anthropic/claude-haiku-4-5",
    "senior": "anthropic/claude-opus-4-5"
  }
}
```

This calls `devclaw_setup` directly without conversational prompts.

### 3. Channel binding (optional, for new agents)

If you created a new agent during conversational onboarding and selected a channel binding (telegram/whatsapp), the agent is automatically bound and will receive messages from that channel. **Skip to step 4.**

**Smart Migration**: If an existing agent already has a channel-wide binding (e.g., the old orchestrator receives all telegram messages), the onboarding agent will:
1. Call `analyze_channel_bindings` to detect the conflict
2. Ask if you want to migrate the binding from the old agent to the new one
3. If you confirm, the binding is automatically moved — no manual config edit needed

This is useful when you're replacing an old orchestrator with a new one.

If you didn't bind a channel during setup, you have two options:

**Option A: Manually edit `openclaw.json`** (for existing agents or post-creation binding)

Add an entry to the `bindings` array:
```json
{
  "bindings": [
    {
      "agentId": "my-orchestrator",
      "match": {
        "channel": "telegram"
      }
    }
  ]
}
```

For group-specific bindings:
```json
{
  "agentId": "my-orchestrator",
  "match": {
    "channel": "telegram",
    "peer": {
      "kind": "group",
      "id": "-1234567890"
    }
  }
}
```

Restart OpenClaw after editing.

**Option B: Add bot to Telegram/WhatsApp group**

If using a channel-wide binding (no peer filter), the agent will receive all messages from that channel. Add your orchestrator bot to the relevant Telegram group for the project.

### 4. Register your project

Tell the orchestrator agent to register a new project:

> "Register project my-project at ~/git/my-project for group -1234567890 with base branch development"

The agent calls `project_register`, which atomically:
- Validates the repo and auto-detects GitHub/GitLab from remote
- Creates all 8 state labels (idempotent)
- Scaffolds role instruction files (`roles/<project>/dev.md` and `qa.md`)
- Adds the project entry to `projects.json` with `autoChain: false`
- Logs the registration event

```json
{
  "projects": {
    "-1234567890": {
      "name": "my-project",
      "repo": "~/git/my-project",
      "groupName": "Dev - My Project",
      "deployUrl": "",
      "baseBranch": "development",
      "deployBranch": "development",
      "autoChain": false,
      "dev": {
        "active": false,
        "issueId": null,
        "startTime": null,
        "model": null,
        "sessions": { "junior": null, "medior": null, "senior": null }
      },
      "qa": {
        "active": false,
        "issueId": null,
        "startTime": null,
        "model": null,
        "sessions": { "qa": null }
      }
    }
  }
}
```

**Manual fallback:** If you prefer CLI control, you can still create labels manually with `glab label create` and edit `projects.json` directly. See the [Architecture docs](ARCHITECTURE.md) for label names and colors.

**Finding the Telegram group ID:** The group ID is the numeric ID of your Telegram supergroup (a negative number like `-1234567890`). You can find it via the Telegram bot API or from message metadata in OpenClaw logs.

### 5. Create your first issue

Issues can be created in multiple ways:
- **Via the agent** — Ask the orchestrator in the Telegram group: "Create an issue for adding a login page" (uses `task_create`)
- **Via workers** — DEV/QA workers can call `task_create` to file follow-up bugs they discover
- **Via CLI** — `cd ~/git/my-project && glab issue create --title "My first task" --label "To Do"` (or `gh issue create`)
- **Via web UI** — Create an issue and add the "To Do" label

### 6. Test the pipeline

Ask the agent in the Telegram group:

> "Check the queue status"

The agent should call `queue_status` and report the "To Do" issue. Then:

> "Pick up issue #1 for DEV"

The agent calls `task_pickup`, which assigns a developer tier, transitions the label to "Doing", creates or reuses a worker session, and dispatches the task — all in one call. The agent just posts the announcement.

## Adding more projects

Tell the agent to register a new project (step 3) and add the bot to the new Telegram group (step 4). That's it — `project_register` handles labels and state setup.

Each project is fully isolated — separate queue, separate workers, separate state.

## Developer tiers

DevClaw assigns tasks to developer tiers instead of raw model names. This makes the system intuitive — you're assigning a "junior dev" to fix a typo, not configuring model parameters.

| Tier | Role | Default model | When to assign |
|------|------|---------------|----------------|
| **junior** | Junior developer | `anthropic/claude-haiku-4-5` | Typos, single-file fixes, CSS changes |
| **medior** | Mid-level developer | `anthropic/claude-sonnet-4-5` | Features, bug fixes, multi-file changes |
| **senior** | Senior developer | `anthropic/claude-opus-4-5` | Architecture, migrations, system-wide refactoring |
| **qa** | QA engineer | `anthropic/claude-sonnet-4-5` | Code review, test validation |

Change which model powers each tier in `openclaw.json`:
```json
{
  "plugins": {
    "entries": {
      "devclaw": {
        "config": {
          "models": {
            "junior": "anthropic/claude-haiku-4-5",
            "medior": "anthropic/claude-sonnet-4-5",
            "senior": "anthropic/claude-opus-4-5",
            "qa": "anthropic/claude-sonnet-4-5"
          }
        }
      }
    }
  }
}
```

## What the plugin handles vs. what you handle

| Responsibility | Who | Details |
|---|---|---|
| Plugin installation | You (once) | `cp -r devclaw ~/.openclaw/extensions/` |
| Agent + workspace setup | Plugin (`devclaw_setup`) | Creates agent, configures models, writes workspace files |
| Channel binding analysis | Plugin (`analyze_channel_bindings`) | Detects channel conflicts, validates channel configuration |
| Channel binding migration | Plugin (`devclaw_setup` with `migrateFrom`) | Automatically moves channel-wide bindings between agents |
| Label setup | Plugin (`project_register`) | 8 labels, created idempotently via `IssueProvider` |
| Role file scaffolding | Plugin (`project_register`) | Creates `roles/<project>/dev.md` and `qa.md` from defaults |
| Project registration | Plugin (`project_register`) | Entry in `projects.json` with empty worker state |
| Telegram group setup | You (once per project) | Add bot to group |
| Issue creation | Plugin (`task_create`) | Orchestrator or workers create issues from chat |
| Label transitions | Plugin | Atomic label transitions via issue tracker CLI |
| Developer assignment | Plugin | LLM-selected tier by orchestrator, keyword heuristic fallback |
| State management | Plugin | Atomic read/write to `projects.json` |
| Session management | Plugin | Creates, reuses, and dispatches to sessions via CLI. Agent never touches session tools. |
| Task completion | Plugin (`task_complete`) | Workers self-report. Auto-chains if enabled. |
| Role instructions | Plugin (`task_pickup`) | Loaded from `roles/<project>/<role>.md`, appended to task message |
| Audit logging | Plugin | Automatic NDJSON append per tool call |
| Zombie detection | Plugin | `session_health` checks active vs alive |
| Queue scanning | Plugin | `queue_status` queries issue tracker per project |
