# DevClaw — Configuration Reference

DevClaw uses a three-layer configuration system. All role, workflow, and timeout settings live in `workflow.yaml` files — not in `openclaw.json`.

## Three-Layer Config Resolution

```
Layer 1: Built-in defaults (ROLE_REGISTRY + DEFAULT_WORKFLOW)
Layer 2: Workspace:  <workspace>/devclaw/workflow.yaml
Layer 3: Project:    <workspace>/devclaw/projects/<project>/workflow.yaml
```

Each layer can partially override the one below it. Only the fields you specify are merged — everything else inherits from the layer below.

**Source:** [`lib/config/loader.ts`](../lib/config/loader.ts)

**Validation:** Config is validated at load time with Zod schemas ([`lib/config/schema.ts`](../lib/config/schema.ts)). Integrity checks verify transition targets exist, queue states have roles, and terminal states have no outgoing transitions.

---

## Workflow Config (`workflow.yaml`)

The `workflow.yaml` file configures roles, workflow states, and timeouts. Place it at `<workspace>/devclaw/workflow.yaml` for workspace-wide settings, or at `<workspace>/devclaw/projects/<project>/workflow.yaml` for project-specific overrides.

### Role Configuration

Override which LLM model powers each level, customize levels, or disable roles entirely:

```yaml
roles:
  developer:
    models:
      junior: anthropic/claude-haiku-4-5
      medior: anthropic/claude-sonnet-4-5
      senior: anthropic/claude-opus-4-6
  tester:
    models:
      junior: anthropic/claude-haiku-4-5
      medior: anthropic/claude-sonnet-4-5
      senior: anthropic/claude-opus-4-6
  architect:
    models:
      junior: anthropic/claude-sonnet-4-5
      senior: anthropic/claude-opus-4-6
  # Disable a role entirely:
  # architect: false
```

**Role override fields** (all optional — only override what you need):

| Field | Type | Description |
|---|---|---|
| `levels` | string[] | Available levels for this role |
| `defaultLevel` | string | Default level when not specified |
| `models` | Record<string, string> | Model ID per level |
| `emoji` | Record<string, string> | Emoji per level for announcements |
| `completionResults` | string[] | Valid completion results |

**Default models:**

| Role | Level | Default Model |
|---|---|---|
| developer | junior | `anthropic/claude-haiku-4-5` |
| developer | medior | `anthropic/claude-sonnet-4-5` |
| developer | senior | `anthropic/claude-opus-4-6` |
| tester | junior | `anthropic/claude-haiku-4-5` |
| tester | medior | `anthropic/claude-sonnet-4-5` |
| tester | senior | `anthropic/claude-opus-4-6` |
| architect | junior | `anthropic/claude-sonnet-4-5` |
| architect | senior | `anthropic/claude-opus-4-6` |

**Source:** [`lib/roles/registry.ts`](../lib/roles/registry.ts)

**Model resolution order:**

1. Project `workflow.yaml` → `roles.<role>.models.<level>`
2. Workspace `workflow.yaml` → `roles.<role>.models.<level>`
3. Built-in defaults from `ROLE_REGISTRY`
4. Passthrough — treat the level string as a raw model ID

### Workflow States

The workflow section defines the state machine for issue lifecycle. Each state has a type, label, color, and optional transitions:

```yaml
workflow:
  initial: planning
  states:
    planning:
      type: hold
      label: Planning
      color: "#95a5a6"
      on:
        APPROVE: todo
    todo:
      type: queue
      role: developer
      label: To Do
      color: "#428bca"
      priority: 1
      on:
        PICKUP: doing
    doing:
      type: active
      role: developer
      label: Doing
      color: "#f0ad4e"
      on:
        COMPLETE:
          target: toTest
          actions: [gitPull, detectPr]
        REVIEW:
          target: reviewing
          actions: [detectPr]
        BLOCKED: refining
    toTest:
      type: queue
      role: tester
      label: To Test
      color: "#5bc0de"
      priority: 2
      on:
        PICKUP: testing
    testing:
      type: active
      role: tester
      label: Testing
      color: "#9b59b6"
      on:
        PASS:
          target: done
          actions: [closeIssue]
        FAIL:
          target: toImprove
          actions: [reopenIssue]
        REFINE: refining
        BLOCKED: refining
    toImprove:
      type: queue
      role: developer
      label: To Improve
      color: "#d9534f"
      priority: 3
      on:
        PICKUP: doing
    refining:
      type: hold
      label: Refining
      color: "#f39c12"
      on:
        APPROVE: todo
    reviewing:
      type: review
      label: In Review
      color: "#c5def5"
      check: prApproved
      on:
        APPROVED:
          target: toTest
          actions: [mergePr, gitPull]
        MERGE_FAILED: toImprove
        BLOCKED: refining
    done:
      type: terminal
      label: Done
      color: "#5cb85c"
    toDesign:
      type: queue
      role: architect
      label: To Design
      color: "#0075ca"
      priority: 1
      on:
        PICKUP: designing
    designing:
      type: active
      role: architect
      label: Designing
      color: "#d4c5f9"
      on:
        COMPLETE: planning
        BLOCKED: refining
```

**State types:**

| Type | Description |
|---|---|
| `queue` | Waiting for pickup. Must have a `role`. Has `priority` for ordering. |
| `active` | Worker is currently working on it. Must have a `role`. |
| `hold` | Paused, awaiting human decision. |
| `review` | Awaiting external check (PR approved/merged). Has `check` field. Heartbeat polls and auto-transitions. |
| `terminal` | Completed. No outgoing transitions. |

**Built-in actions:**

| Action | Description |
|---|---|
| `gitPull` | Pull latest from the base branch |
| `detectPr` | Auto-detect PR URL from the issue |
| `mergePr` | Merge the PR associated with the issue. Critical in review states (aborts on failure). |
| `closeIssue` | Close the issue |
| `reopenIssue` | Reopen the issue |

**Review checks:**

| Check | Description |
|---|---|
| `prMerged` | Transition when the issue's PR is merged |
| `prApproved` | Transition when the issue's PR is approved or merged |

### Timeouts

```yaml
timeouts:
  gitPullMs: 30000
  gatewayMs: 120000
  sessionPatchMs: 120000
  dispatchMs: 120000
  staleWorkerHours: 2
```

| Setting | Default | Description |
|---|---|---|
| `gitPullMs` | 30000 | Timeout for git pull operations |
| `gatewayMs` | 120000 | Timeout for gateway RPC calls |
| `sessionPatchMs` | 120000 | Timeout for session creation |
| `dispatchMs` | 120000 | Timeout for task dispatch |
| `staleWorkerHours` | 2 | Hours before a worker is considered stale |

---

## Plugin Configuration (`openclaw.json`)

Some settings still live in `openclaw.json` under `plugins.entries.devclaw.config`:

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

The heartbeat service runs as a plugin service tied to the gateway lifecycle. Every tick: health pass (auto-fix zombies, stale workers) → review pass (poll PR status for "In Review" issues) → tick pass (fill free slots by priority). Zero LLM tokens consumed.

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
            "onboard",
            "design_task"
          ]
        }
      }
    ]
  }
}
```

---

## Project State (`projects.json`)

All project state lives in `<workspace>/devclaw/projects.json`, keyed by group ID.

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
      "provider": "github",
      "roleExecution": "parallel",
      "workers": {
        "developer": {
          "active": false,
          "issueId": null,
          "startTime": null,
          "level": null,
          "sessions": {
            "junior": null,
            "medior": "agent:orchestrator:subagent:my-webapp-developer-medior",
            "senior": null
          }
        },
        "tester": {
          "active": false,
          "issueId": null,
          "startTime": null,
          "level": null,
          "sessions": {
            "junior": null,
            "medior": "agent:orchestrator:subagent:my-webapp-tester-medior",
            "senior": null
          }
        },
        "architect": {
          "active": false,
          "issueId": null,
          "startTime": null,
          "level": null,
          "sessions": {
            "junior": null,
            "senior": null
          }
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
| `provider` | `"github"` \| `"gitlab"` | Issue tracker provider (auto-detected, stored for reuse) |
| `roleExecution` | `"parallel"` \| `"sequential"` | DEVELOPER/TESTER parallelism for this project |

### Worker state fields

Each role in the `workers` record has a `WorkerState` object:

| Field | Type | Description |
|---|---|---|
| `active` | boolean | Whether this role has an active worker |
| `issueId` | string \| null | Issue being worked on (as string) |
| `startTime` | string \| null | ISO timestamp when worker became active |
| `level` | string \| null | Current level (`junior`, `medior`, `senior`) |
| `sessions` | Record<string, string \| null> | Per-level session keys |

### Key design decisions

- **Session-per-level** — each level gets its own worker session, accumulating context independently. Level selection maps directly to a session key.
- **Sessions preserved on completion** — when a worker completes a task, the sessions map is preserved (only `active`, `issueId`, and `startTime` are cleared). This enables session reuse.
- **Atomic writes** — all writes go through temp-file-then-rename to prevent corruption. File locking prevents concurrent read-modify-write races.
- **Sessions persist indefinitely** — no auto-cleanup. The `health` tool handles manual cleanup.
- **Dynamic workers** — the `workers` record is keyed by role ID (e.g., `developer`, `tester`, `architect`). New roles are created automatically when dispatched.

---

## Workspace File Layout

```
<workspace>/
├── devclaw/
│   ├── projects.json              ← Project state (auto-managed)
│   ├── workflow.yaml              ← Workspace-level config overrides
│   ├── prompts/
│   │   ├── developer.md           ← Default developer instructions
│   │   ├── tester.md              ← Default tester instructions
│   │   └── architect.md           ← Default architect instructions
│   ├── projects/
│   │   ├── my-webapp/
│   │   │   ├── workflow.yaml      ← Project-specific config overrides
│   │   │   └── prompts/
│   │   │       ├── developer.md   ← Project-specific developer instructions
│   │   │       ├── tester.md      ← Project-specific tester instructions
│   │   │       └── architect.md   ← Project-specific architect instructions
│   │   └── another-project/
│   │       └── prompts/
│   │           ├── developer.md
│   │           └── tester.md
│   └── log/
│       └── audit.log              ← NDJSON event log (auto-managed)
├── AGENTS.md                      ← Agent identity documentation
└── HEARTBEAT.md                   ← Heartbeat operation guide
```

### Role instruction files

Role instructions are injected into worker sessions via the `agent:bootstrap` hook at session startup. The hook loads instructions from `devclaw/projects/<project>/prompts/<role>.md`, falling back to `devclaw/prompts/<role>.md`.

Edit to customize: deployment steps, test commands, acceptance criteria, coding standards.

**Source:** [`lib/bootstrap-hook.ts`](../lib/bootstrap-hook.ts)

---

## Audit Log

Append-only NDJSON at `<workspace>/devclaw/log/audit.log`. Auto-truncated to 250 lines.

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

**Provider resilience:** All calls are wrapped with cockatiel retry (3 attempts, exponential backoff) + circuit breaker (opens after 5 consecutive failures, half-opens after 30s). See [`lib/providers/resilience.ts`](../lib/providers/resilience.ts).

**Planned:** Jira (via REST API)

**Source:** [`lib/providers/index.ts`](../lib/providers/index.ts)
