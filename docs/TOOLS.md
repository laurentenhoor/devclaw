# DevClaw — Tools Reference

Complete reference for all 11 tools registered by DevClaw. See [`index.ts`](../index.ts) for registration.

## Worker Lifecycle

### `work_start`

Pick up a task from the issue queue. Handles level assignment, label transition, session creation/reuse, task dispatch, and audit logging — all in one call.

**Source:** [`lib/tools/work-start.ts`](../lib/tools/work-start.ts)

**Context:** Only works in project group chats.

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `issueId` | number | No | Issue ID. If omitted, picks next by priority. |
| `role` | `"dev"` \| `"qa"` | No | Worker role. Auto-detected from issue label if omitted. |
| `projectGroupId` | string | No | Project group ID. Auto-detected from group context. |
| `level` | string | No | Developer level (`junior`, `medior`, `senior`, `reviewer`). Auto-detected if omitted. |

**What it does atomically:**

1. Resolves project from `projects.json`
2. Validates no active worker for this role
3. Fetches issue from tracker, verifies correct label state
4. Assigns level (LLM-chosen via `level` param → label detection → keyword heuristic fallback)
5. Resolves level to model ID via config or defaults
6. Loads prompt instructions from `projects/roles/<project>/<role>.md`
7. Looks up existing session for assigned level (session-per-level)
8. Transitions label (e.g. `To Do` → `Doing`)
9. Creates session via Gateway RPC if new (`sessions.patch`)
10. Dispatches task to worker session via CLI (`openclaw gateway call agent`)
11. Updates `projects.json` state (active, issueId, level, session key)
12. Writes audit log entries (work_start + model_selection)
13. Sends notification
14. Returns announcement text

**Level selection priority:**

1. `level` parameter (LLM-selected) — highest priority
2. Issue label (e.g. a label named "junior" or "senior")
3. Keyword heuristic from `model-selector.ts` — fallback

**Execution guards:**

- Rejects if role already has an active worker
- Respects `roleExecution` (sequential: rejects if other role is active)

**On failure:** Rolls back label transition. No orphaned state.

---

### `work_finish`

Complete a task with a result. Called by workers (DEV/QA sub-agent sessions) directly, or by the orchestrator.

**Source:** [`lib/tools/work-finish.ts`](../lib/tools/work-finish.ts)

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `role` | `"dev"` \| `"qa"` | Yes | Worker role |
| `result` | string | Yes | Completion result (see table below) |
| `projectGroupId` | string | Yes | Project group ID |
| `summary` | string | No | Brief summary for the announcement |
| `prUrl` | string | No | PR/MR URL (auto-detected if omitted) |

**Valid results by role:**

| Role | Result | Label transition | Side effects |
|---|---|---|---|
| DEV | `"done"` | Doing → To Test | git pull, auto-detect PR URL |
| DEV | `"blocked"` | Doing → To Do | Task returns to queue |
| QA | `"pass"` | Testing → Done | Issue closed |
| QA | `"fail"` | Testing → To Improve | Issue reopened |
| QA | `"refine"` | Testing → Refining | Awaits human decision |
| QA | `"blocked"` | Testing → To Test | Task returns to QA queue |

**What it does atomically:**

1. Validates role:result combination
2. Resolves project and active worker
3. Executes completion via pipeline service (label transition + side effects)
4. Deactivates worker (sessions map preserved for reuse)
5. Sends notification
6. Ticks queue to fill free worker slots
7. Writes audit log

**Scheduling:** After completion, `work_finish` ticks the queue. The scheduler sees the new label (`To Test` or `To Improve`) and dispatches the next worker if a slot is free.

---

## Task Management

### `task_create`

Create a new issue in the project's issue tracker.

**Source:** [`lib/tools/task-create.ts`](../lib/tools/task-create.ts)

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectGroupId` | string | Yes | Project group ID |
| `title` | string | Yes | Issue title |
| `description` | string | No | Full issue body (markdown) |
| `label` | StateLabel | No | State label. Defaults to `"Planning"`. |
| `assignees` | string[] | No | GitHub/GitLab usernames to assign |
| `pickup` | boolean | No | If true, immediately pick up for DEV after creation |

**Use cases:**

- Orchestrator creates tasks from chat messages
- Workers file follow-up bugs discovered during development
- Breaking down epics into smaller tasks

**Default behavior:** Creates issues in `"Planning"` state. Only use `"To Do"` when the user explicitly requests immediate work.

---

### `task_update`

Change an issue's state label manually without going through the full pickup/complete flow.

**Source:** [`lib/tools/task-update.ts`](../lib/tools/task-update.ts)

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectGroupId` | string | Yes | Project group ID |
| `issueId` | number | Yes | Issue ID to update |
| `state` | StateLabel | Yes | New state label |
| `reason` | string | No | Audit log reason for the change |

**Valid states:** `Planning`, `To Do`, `Doing`, `To Test`, `Testing`, `Done`, `To Improve`, `Refining`

**Use cases:**

- Manual state adjustments (e.g. `Planning → To Do` after approval)
- Failed auto-transitions that need correction
- Bulk state changes by orchestrator

---

### `task_comment`

Add a comment to an issue for feedback, notes, or discussion.

**Source:** [`lib/tools/task-comment.ts`](../lib/tools/task-comment.ts)

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectGroupId` | string | Yes | Project group ID |
| `issueId` | number | Yes | Issue ID to comment on |
| `body` | string | Yes | Comment body (markdown) |
| `authorRole` | `"dev"` \| `"qa"` \| `"orchestrator"` | No | Attribution role prefix |

**Use cases:**

- QA adds review feedback before pass/fail decision
- DEV posts implementation notes or progress updates
- Orchestrator adds summary comments

When `authorRole` is provided, the comment is prefixed with a role emoji and attribution label.

---

## Operations

### `status`

Lightweight queue + worker state dashboard.

**Source:** [`lib/tools/status.ts`](../lib/tools/status.ts)

**Context:** Auto-filters to project in group chats. Shows all projects in DMs.

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectGroupId` | string | No | Filter to specific project. Omit for all. |

**Returns per project:**

- Worker state: active/idle, current issue, level, start time
- Queue counts: To Do, To Test, To Improve
- Role execution mode

---

### `health`

Worker health scan with optional auto-fix.

**Source:** [`lib/tools/health.ts`](../lib/tools/health.ts)

**Context:** Auto-filters to project in group chats.

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectGroupId` | string | No | Filter to specific project. Omit for all. |
| `fix` | boolean | No | Apply fixes for detected issues. Default: `false` (read-only). |
| `activeSessions` | string[] | No | Active session IDs for zombie detection. |

**Health checks:**

| Issue | Severity | Detection | Auto-fix |
|---|---|---|---|
| Active worker with no session key | Critical | `active=true` but no session in map | Deactivate worker |
| Active worker whose session is dead | Critical | Session key not in active sessions list | Deactivate worker, revert label |
| Worker active >2 hours | Warning | `startTime` older than 2h | Deactivate worker, revert label to queue |
| Inactive worker with lingering issue ID | Warning | `active=false` but `issueId` still set | Clear issueId |

---

### `work_heartbeat`

Manual trigger for heartbeat: health fix + queue dispatch. Same logic as the background heartbeat service, but invoked on demand.

**Source:** [`lib/tools/work-heartbeat.ts`](../lib/tools/work-heartbeat.ts)

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectGroupId` | string | No | Target single project. Omit for all. |
| `dryRun` | boolean | No | Report only, don't dispatch. Default: `false`. |
| `maxPickups` | number | No | Max worker dispatches per tick. |
| `activeSessions` | string[] | No | Active session IDs for zombie detection. |

**Two-pass sweep:**

1. **Health pass** — Runs `checkWorkerHealth` per project per role. Auto-fixes zombies, stale workers, orphaned state.
2. **Tick pass** — Calls `projectTick` per project. Fills free worker slots by priority (To Improve > To Test > To Do).

**Execution guards:**

- `projectExecution: "sequential"` — only one project active at a time
- `roleExecution: "sequential"` — only one role (DEV or QA) active at a time per project (enforced in `projectTick`)

---

## Setup

### `project_register`

One-time project setup. Creates state labels, scaffolds prompt files, adds project to state.

**Source:** [`lib/tools/project-register.ts`](../lib/tools/project-register.ts)

**Context:** Only works in the Telegram/WhatsApp group being registered.

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectGroupId` | string | No | Auto-detected from current group if omitted |
| `name` | string | Yes | Short project name (e.g. `my-webapp`) |
| `repo` | string | Yes | Path to git repo (e.g. `~/git/my-project`) |
| `groupName` | string | No | Display name. Defaults to `Project: {name}`. |
| `baseBranch` | string | Yes | Base branch for development |
| `deployBranch` | string | No | Deploy branch. Defaults to baseBranch. |
| `deployUrl` | string | No | Deployment URL |
| `roleExecution` | `"parallel"` \| `"sequential"` | No | DEV/QA parallelism. Default: `"parallel"`. |

**What it does atomically:**

1. Validates project not already registered
2. Resolves repo path, auto-detects GitHub/GitLab from git remote
3. Verifies provider health (CLI installed and authenticated)
4. Creates all 8 state labels (idempotent — safe to run again)
5. Adds project entry to `projects.json` with empty worker state
   - DEV sessions: `{ junior: null, medior: null, senior: null }`
   - QA sessions: `{ reviewer: null, tester: null }`
6. Scaffolds prompt files: `projects/roles/<project>/dev.md` and `qa.md`
7. Writes audit log

---

### `setup`

Agent + workspace initialization.

**Source:** [`lib/tools/setup.ts`](../lib/tools/setup.ts)

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `newAgentName` | string | No | Create a new agent. Omit to configure current workspace. |
| `channelBinding` | `"telegram"` \| `"whatsapp"` | No | Channel to bind (with `newAgentName` only) |
| `migrateFrom` | string | No | Agent ID to migrate channel binding from |
| `models` | object | No | Model overrides per role and level (see [Configuration](CONFIGURATION.md#model-tiers)) |
| `projectExecution` | `"parallel"` \| `"sequential"` | No | Project execution mode |

**What it does:**

1. Creates a new agent or configures existing workspace
2. Optionally binds messaging channel (Telegram/WhatsApp)
3. Optionally migrates channel binding from another agent
4. Writes workspace files: AGENTS.md, HEARTBEAT.md, `projects/projects.json`
5. Configures model tiers in `openclaw.json`

---

### `onboard`

Conversational onboarding guide. Returns step-by-step instructions for the agent to walk the user through setup.

**Source:** [`lib/tools/onboard.ts`](../lib/tools/onboard.ts)

**Note:** Call this before `setup` to get step-by-step guidance.

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `mode` | `"first-run"` \| `"reconfigure"` | No | Auto-detected from current state |

**Flow:**

1. Call `onboard` — returns QA-style step-by-step instructions
2. Agent walks user through: agent selection, channel binding, model tiers
3. Agent calls `setup` with collected answers
4. User registers projects via `project_register` in group chats

---

## Completion Rules Reference

The pipeline service (`lib/services/pipeline.ts`) defines declarative completion rules:

```
dev:done    → Doing    → To Test     (git pull, detect PR)
dev:blocked → Doing    → To Do       (return to queue)
qa:pass     → Testing  → Done        (close issue)
qa:fail     → Testing  → To Improve  (reopen issue)
qa:refine   → Testing  → Refining    (await human decision)
qa:blocked  → Testing  → To Test     (return to QA queue)
```

## Issue Priority Order

When the heartbeat or `work_heartbeat` fills free worker slots, issues are prioritized:

1. **To Improve** — QA failures get fixed first (highest priority)
2. **To Test** — Completed DEV work gets reviewed next
3. **To Do** — Fresh tasks are picked up last

This ensures the pipeline clears its backlog before starting new work.
