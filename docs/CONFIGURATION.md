# DevClaw — Configuration Reference

All DevClaw configuration lives in two places: `openclaw.json` (plugin-level settings) and `projects.json` (per-project state).

## Plugin Configuration (`openclaw.json`)

DevClaw is configured under `plugins.entries.devclaw.config` in `openclaw.json`.

### Model Tiers

Override which LLM model powers each developer level:

```json
{
  "plugins": {
    "entries": {
      "devclaw": {
        "config": {
          "models": {
            "dev": {
              "junior": "anthropic/claude-haiku-4-5",
              "medior": "anthropic/claude-sonnet-4-5",
              "senior": "anthropic/claude-opus-4-5"
            },
            "qa": {
              "reviewer": "anthropic/claude-sonnet-4-5",
              "tester": "anthropic/claude-haiku-4-5"
            }
          }
        }
      }
    }
  }
}
```

**Resolution order** (per `lib/tiers.ts:resolveModel`):

1. Plugin config `models.<role>.<level>` — explicit override
2. `DEFAULT_MODELS[role][level]` — built-in defaults (table below)
3. Passthrough — treat the level string as a raw model ID

**Default models:**

| Role | Level | Default model |
|---|---|---|
| dev | junior | `anthropic/claude-haiku-4-5` |
| dev | medior | `anthropic/claude-sonnet-4-5` |
| dev | senior | `anthropic/claude-opus-4-5` |
| qa | reviewer | `anthropic/claude-sonnet-4-5` |
| qa | tester | `anthropic/claude-haiku-4-5` |

### Project Execution Mode

Controls cross-project parallelism:

```json
{
  "plugins": {
    "entries": {
      "devclaw": {
        "config": {
          "projectExecution": "parallel"
        }
      }
    }
  }
}
```

| Value | Behavior |
|---|---|
| `"parallel"` (default) | Multiple projects can have active workers simultaneously |
| `"sequential"` | Only one project's workers active at a time. Useful for single-agent deployments. |

Enforced in `work_heartbeat` and the heartbeat service before dispatching.

### Heartbeat Service

Token-free interval-based health checks + queue dispatch:

```json
{
  "plugins": {
    "entries": {
      "devclaw": {
        "config": {
          "work_heartbeat": {
            "enabled": true,
            "intervalSeconds": 60,
            "maxPickupsPerTick": 4
          }
        }
      }
    }
  }
}
```

| Setting | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Enable the heartbeat service |
| `intervalSeconds` | number | `60` | Seconds between ticks |
| `maxPickupsPerTick` | number | `4` | Maximum worker dispatches per tick (budget control) |

**Source:** [`lib/services/heartbeat.ts`](../lib/services/heartbeat.ts)

The heartbeat service runs as a plugin service tied to the gateway lifecycle. Every tick: health pass (auto-fix zombies, stale workers) → tick pass (fill free slots by priority). Zero LLM tokens consumed.

### Notifications

Control which lifecycle events send notifications:

```json
{
  "plugins": {
    "entries": {
      "devclaw": {
        "config": {
          "notifications": {
            "heartbeatDm": true,
            "workerStart": true,
            "workerComplete": true
          }
        }
      }
    }
  }
}
```

| Setting | Default | Description |
|---|---|---|
| `heartbeatDm` | `true` | Send heartbeat summary to orchestrator DM |
| `workerStart` | `true` | Announce when a worker picks up a task |
| `workerComplete` | `true` | Announce when a worker finishes a task |

### Agent Tool Permissions

Restrict DevClaw tools to your orchestrator agent:

```json
{
  "agents": {
    "list": [
      {
        "id": "my-orchestrator",
        "tools": {
          "allow": [
            "work_start",
            "work_finish",
            "task_create",
            "task_update",
            "task_comment",
            "status",
            "health",
            "work_heartbeat",
            "project_register",
            "setup",
            "onboard"
          ]
        }
      }
    ]
  }
}
```

---

## Project State (`projects.json`)

All project state lives in `<workspace>/projects/projects.json`, keyed by group ID.

**Source:** [`lib/projects.ts`](../lib/projects.ts)

### Schema

```json
{
  "projects": {
    "<groupId>": {
      "name": "my-webapp",
      "repo": "~/git/my-webapp",
      "groupName": "Dev - My Webapp",
      "baseBranch": "development",
      "deployBranch": "development",
      "deployUrl": "https://my-webapp.example.com",
      "channel": "telegram",
      "roleExecution": "parallel",
      "dev": {
        "active": false,
        "issueId": null,
        "startTime": null,
        "level": null,
        "sessions": {
          "junior": null,
          "medior": "agent:orchestrator:subagent:my-webapp-dev-medior",
          "senior": null
        }
      },
      "qa": {
        "active": false,
        "issueId": null,
        "startTime": null,
        "level": null,
        "sessions": {
          "reviewer": "agent:orchestrator:subagent:my-webapp-qa-reviewer",
          "tester": null
        }
      }
    }
  }
}
```

### Project fields

| Field | Type | Description |
|---|---|---|
| `name` | string | Short project name |
| `repo` | string | Path to git repo (supports `~/` expansion) |
| `groupName` | string | Group display name |
| `baseBranch` | string | Base branch for development |
| `deployBranch` | string | Branch that triggers deployment |
| `deployUrl` | string | Deployment URL |
| `channel` | string | Messaging channel (`"telegram"`, `"whatsapp"`, etc.) |
| `roleExecution` | `"parallel"` \| `"sequential"` | DEV/QA parallelism for this project |

### Worker state fields

Each project has `dev` and `qa` worker state objects:

| Field | Type | Description |
|---|---|---|
| `active` | boolean | Whether this role has an active worker |
| `issueId` | string \| null | Issue being worked on (as string) |
| `startTime` | string \| null | ISO timestamp when worker became active |
| `level` | string \| null | Current level (`junior`, `medior`, `senior`, `reviewer`, `tester`) |
| `sessions` | Record<string, string \| null> | Per-level session keys |

**DEV session keys:** `junior`, `medior`, `senior`
**QA session keys:** `reviewer`, `tester`

### Key design decisions

- **Session-per-level** — each level gets its own worker session, accumulating context independently. Level selection maps directly to a session key.
- **Sessions preserved on completion** — when a worker completes a task, the sessions map is preserved (only `active`, `issueId`, and `startTime` are cleared). This enables session reuse.
- **Atomic writes** — all writes go through temp-file-then-rename to prevent corruption.
- **Sessions persist indefinitely** — no auto-cleanup. The `health` tool handles manual cleanup.

---

## Workspace File Layout

```
<workspace>/
├── projects/
│   ├── projects.json          ← Project state (auto-managed)
│   └── roles/
│       ├── my-webapp/         ← Per-project role instructions (editable)
│       │   ├── dev.md
│       │   └── qa.md
│       ├── another-project/
│       │   ├── dev.md
│       │   └── qa.md
│       └── default/           ← Fallback role instructions
│           ├── dev.md
│           └── qa.md
├── log/
│   └── audit.log              ← NDJSON event log (auto-managed)
├── AGENTS.md                  ← Agent identity documentation
└── HEARTBEAT.md               ← Heartbeat operation guide
```

### Role instruction files

`work_start` loads role instructions from `projects/roles/<project>/<role>.md` at dispatch time, falling back to `projects/roles/default/<role>.md`. These files are appended to the task message sent to worker sessions.

Edit to customize: deployment steps, test commands, acceptance criteria, coding standards.

**Source:** [`lib/dispatch.ts:loadRoleInstructions`](../lib/dispatch.ts)

---

## Audit Log

Append-only NDJSON at `<workspace>/log/audit.log`. Auto-truncated to 250 lines.

**Source:** [`lib/audit.ts`](../lib/audit.ts)

### Event types

| Event | Trigger |
|---|---|
| `work_start` | Task dispatched to worker |
| `model_selection` | Level resolved to model ID |
| `work_finish` | Task completed |
| `work_heartbeat` | Heartbeat tick completed |
| `task_create` | Issue created |
| `task_update` | Issue state changed |
| `task_comment` | Comment added to issue |
| `status` | Queue status queried |
| `health` | Health scan completed |
| `heartbeat_tick` | Heartbeat service tick (background) |
| `project_register` | Project registered |

### Querying

```bash
# All task dispatches
cat audit.log | jq 'select(.event=="work_start")'

# All completions for a project
cat audit.log | jq 'select(.event=="work_finish" and .project=="my-webapp")'

# Model selections
cat audit.log | jq 'select(.event=="model_selection")'
```

---

## Issue Provider

DevClaw uses an `IssueProvider` interface (`lib/providers/provider.ts`) to abstract issue tracker operations. The provider is auto-detected from the git remote URL.

**Supported providers:**

| Provider | CLI | Detection |
|---|---|---|
| GitHub | `gh` | Remote contains `github.com` |
| GitLab | `glab` | Remote contains `gitlab` |

**Planned:** Jira (via REST API)

**Source:** [`lib/providers/index.ts`](../lib/providers/index.ts)
