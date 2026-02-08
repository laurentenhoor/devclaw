# DevClaw — Onboarding Guide

## What you need before starting

| Requirement | Why | How to check |
|---|---|---|
| [OpenClaw](https://openclaw.ai) installed | DevClaw is an OpenClaw plugin | `openclaw --version` |
| Node.js >= 20 | Runtime for plugin | `node --version` |
| [`glab`](https://gitlab.com/gitlab-org/cli) CLI | GitLab issue/label management | `glab --version` |
| glab authenticated | Plugin calls glab for every label transition | `glab auth status` |
| A GitLab repo with issues | The task backlog lives in GitLab | `glab issue list` from your repo |
| An OpenClaw agent with Telegram | The orchestrator agent that will manage projects | Agent defined in `openclaw.json` |

## Setup steps

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

### 2. Configure your orchestrator agent

In `openclaw.json`, your orchestrator agent needs access to the DevClaw tools:

```json
{
  "agents": {
    "list": [{
      "id": "my-orchestrator",
      "name": "Dev Orchestrator",
      "model": "anthropic/claude-sonnet-4-5",
      "tools": {
        "allow": [
          "task_pickup",
          "task_complete",
          "queue_status",
          "session_health",
          "sessions_spawn",
          "sessions_send",
          "sessions_list"
        ]
      }
    }]
  }
}
```

The agent also needs the OpenClaw session tools (`sessions_spawn`, `sessions_send`, `sessions_list`) — DevClaw handles the orchestration logic (labels, state, model selection, audit), but the agent executes the actual session operations to spawn or communicate with DEV/QA sub-agent sessions.

### 3. Create GitLab labels

DevClaw uses these labels as a state machine. Create them once per GitLab project:

```bash
cd ~/git/your-project
glab label create "Planning" --color "#6699cc"
glab label create "To Do" --color "#428bca"
glab label create "Doing" --color "#f0ad4e"
glab label create "To Test" --color "#5bc0de"
glab label create "Testing" --color "#9b59b6"
glab label create "Done" --color "#5cb85c"
glab label create "To Improve" --color "#d9534f"
glab label create "Refining" --color "#f39c12"
```

### 4. Register a project

Add your project to `memory/projects.json` in the orchestrator's workspace:

```json
{
  "projects": {
    "<telegram-group-id>": {
      "name": "my-project",
      "repo": "~/git/my-project",
      "groupName": "Dev - My Project",
      "deployUrl": "https://my-project.example.com",
      "baseBranch": "development",
      "deployBranch": "development",
      "dev": {
        "active": false,
        "sessionId": null,
        "issueId": null,
        "startTime": null,
        "model": null
      },
      "qa": {
        "active": false,
        "sessionId": null,
        "issueId": null,
        "startTime": null,
        "model": null
      }
    }
  }
}
```

**Finding the Telegram group ID:** The group ID is the numeric ID of your Telegram supergroup (a negative number like `-1234567890`). You can find it via the Telegram bot API or from message metadata in OpenClaw logs.

### 5. Add the agent to the Telegram group

Add your orchestrator bot to the Telegram group for the project. The agent will now receive messages from this group and can operate on the linked project.

### 6. Create your first issue

Issues can be created in multiple ways:
- **Via the agent** — Ask the orchestrator in the Telegram group: "Create an issue for adding a login page"
- **Via glab CLI** — `cd ~/git/my-project && glab issue create --title "My first task" --label "To Do"`
- **Via GitLab UI** — Create an issue and add the "To Do" label

The orchestrator agent and sub-agent sessions can all create and update issues via `glab` tool usage.

### 7. Test the pipeline

Ask the agent in the Telegram group:

> "Check the queue status"

The agent should call `queue_status` and report the "To Do" issue. Then:

> "Pick up issue #1 for DEV"

The agent calls `task_pickup`, which selects a model, transitions the label to "Doing", and returns instructions to spawn or reuse a DEV sub-agent session.

## Adding more projects

Repeat steps 3-5 for each new project:
1. Create labels in the GitLab repo
2. Add an entry to `projects.json` with the new Telegram group ID
3. Add the bot to the new Telegram group

Each project is fully isolated — separate queue, separate workers, separate state.

## What the plugin handles vs. what you handle

| Responsibility | Who | Details |
|---|---|---|
| GitLab label setup | You (once per project) | 8 labels, created via `glab label create` |
| Project registration | You (once per project) | Entry in `projects.json` |
| Agent definition | You (once) | Agent in `openclaw.json` with tool permissions |
| Telegram group setup | You (once per project) | Add bot to group |
| Issue creation | Agent or sub-agents | Created via `glab` tool usage (or manually via GitLab UI) |
| Label transitions | Plugin | Atomic `--unlabel` + `--label` via glab |
| Model selection | Plugin | Keyword-based heuristic per task |
| State management | Plugin | Atomic read/write to `projects.json` |
| Session reuse | Plugin | Detects existing sessions, returns spawn vs send |
| Audit logging | Plugin | Automatic NDJSON append per tool call |
| Zombie detection | Plugin | `session_health` checks active vs alive |
| Queue scanning | Plugin | `queue_status` queries GitLab per project |
