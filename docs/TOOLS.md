# DevClaw — Tools Reference

Complete reference for all 15 tools registered by DevClaw. See [`index.ts`](../index.ts) for registration.

## Worker Lifecycle

### `work_start`

Pick up a task from the issue queue. Handles level assignment, label transition, session creation/reuse, task dispatch, and audit logging — all in one call.

**Source:** [`lib/tools/work-start.ts`](../lib/tools/work-start.ts)

**Context:** Only works in project group chats.

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `issueId` | number | No | Issue ID. If omitted, picks next by priority. |
| `role` | `"developer"` \| `"tester"` \| `"architect"` | No | Worker role. Auto-detected from issue label if omitted. |
| `projectGroupId` | string | No | Project group ID. Auto-detected from group context. |
| `level` | string | No | Level (`junior`, `medior`, `senior`). Auto-detected if omitted. |

**What it does atomically:**

1. Resolves project from `projects.json`
2. Validates no active worker for this role
3. Fetches issue from tracker, verifies correct label state
4. Assigns level (LLM-chosen via `level` param → label detection → keyword heuristic fallback)
5. Resolves level to model ID via config or defaults
6. Looks up existing session for assigned level (session-per-level)
7. Transitions label (e.g. `To Do` → `Doing`)
8. Creates session via Gateway RPC if new (`sessions.patch`)
9. Dispatches task to worker session via CLI (`openclaw gateway call agent`)
10. Updates `projects.json` state (active, issueId, level, session key)
11. Writes audit log entries (work_start + model_selection)
12. Sends notification
13. Returns announcement text

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

Complete a task with a result. Called by workers (DEVELOPER/TESTER/ARCHITECT sub-agent sessions) directly, or by the orchestrator.

**Source:** [`lib/tools/work-finish.ts`](../lib/tools/work-finish.ts)

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `role` | `"developer"` \| `"tester"` \| `"architect"` | Yes | Worker role |
| `result` | string | Yes | Completion result (see table below) |
| `projectGroupId` | string | Yes | Project group ID |
| `summary` | string | No | Brief summary for the announcement |
| `prUrl` | string | No | PR/MR URL (auto-detected if omitted) |

**Valid results by role:**

| Role | Result | Label transition | Side effects |
|---|---|---|---|
| developer | `"done"` | Doing → To Review | auto-detect PR URL. Heartbeat polls PR status. |
| developer | `"blocked"` | Doing → Refining | Awaits human decision |
| reviewer | `"approve"` | Reviewing → Done | merge PR, git pull, close issue |
| reviewer | `"reject"` | Reviewing → To Improve | Sent back to developer |
| reviewer | `"blocked"` | Reviewing → Refining | Awaits human decision |
| tester | `"pass"` | Testing → Done | Issue closed (only when test phase enabled) |
| tester | `"fail"` | Testing → To Improve | Issue reopened (only when test phase enabled) |
| tester | `"refine"` | Testing → Refining | Awaits human decision |
| tester | `"blocked"` | Testing → Refining | Awaits human decision |
| architect | `"done"` | stays in Planning | Design complete, ready for human review |
| architect | `"blocked"` | Planning → Refining | Awaits human decision |

**What it does atomically:**

1. Validates role:result combination
2. Resolves project and active worker
3. Executes completion via pipeline service (label transition + side effects)
4. Deactivates worker (sessions map preserved for reuse)
5. Sends notification
6. Ticks queue to fill free worker slots
7. Writes audit log

**Scheduling:** After completion, `work_finish` ticks the queue. The scheduler sees the new label (`To Review` or `To Improve`) and dispatches the next worker if a slot is free.

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
| `pickup` | boolean | No | If true, immediately pick up for DEVELOPER after creation |

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

**Valid states:** `Planning`, `To Do`, `Doing`, `To Review`, `Reviewing`, `Done`, `To Improve`, `Refining` (and `To Test`, `Testing` if test phase enabled)

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
| `authorRole` | `"developer"` \| `"tester"` \| `"orchestrator"` | No | Attribution role prefix |

**Use cases:**

- TESTER adds review feedback before pass/fail decision
- DEVELOPER posts implementation notes or progress updates
- Orchestrator adds summary comments

When `authorRole` is provided, the comment is prefixed with a role emoji and attribution label.

### `task_edit_body`

Update issue title and/or description. Only allowed when the issue is in the initial workflow state (e.g. "Planning") or an active architect state (e.g. "Researching"). Prevents editing in-progress work.

**Source:** [`lib/tools/task-edit-body.ts`](../lib/tools/task-edit-body.ts)

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectSlug` | string | Yes | Project slug |
| `issueId` | number | Yes | Issue ID to edit |
| `title` | string | No | New title for the issue |
| `body` | string | No | New body/description for the issue |
| `reason` | string | No | Why the edit was made (for audit trail) |
| `addComment` | boolean | No | Post an auto-comment noting the edit. Default: `true`. |

At least one of `title` or `body` must be provided.

**Audit:** Logs the edit with timestamp, caller, and a diff summary. Optionally posts an auto-comment on the issue for traceability.

---

## Operations

### `tasks_status`

Full project dashboard showing all non-terminal state types with issue details.

**Source:** [`lib/tools/tasks-status.ts`](../lib/tools/tasks-status.ts)

**Context:** Auto-filters to project in group chats. Shows all projects in DMs.

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectSlug` | string | No | Filter to specific project. Omit for all. |

**Returns per project:**

- **hold** — Waiting for input (Planning, Refining): issue IDs, titles, URLs
- **active** — Work in progress (Doing, Reviewing, etc.): issue IDs, titles, URLs
- **queue** — Queued for work (To Do, To Improve, To Review): issue IDs, titles, URLs
- Worker state per role: active/idle, current issue, level, start time
- Active workflow summary: review policy, test phase status, state flow
- Summary totals: `totalHold`, `totalActive`, `totalQueued`

---

### `task_list`

Browse and search issues by workflow state. Returns individual issues grouped by state label.

**Source:** [`lib/tools/task-list.ts`](../lib/tools/task-list.ts)

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectSlug` | string | Yes | Project slug |
| `stateType` | `"queue"` \| `"active"` \| `"hold"` \| `"terminal"` \| `"all"` | No | Filter by state type. Default: all non-terminal. |
| `label` | string | No | Specific state label (e.g. `"Planning"`, `"Done"`). Overrides `stateType`. |
| `search` | string | No | Text search in issue titles (case-insensitive). |
| `limit` | number | No | Max issues per state. Default: 20. |

**Returns per matching state:**

- State label, type, and role
- Issue list: ID, title, URL
- Total count (before limit)

**Use cases:**

- Browse all issues in Planning: `{ projectSlug: "my-app", label: "Planning" }`
- Find blocked work: `{ projectSlug: "my-app", stateType: "hold" }`
- Search across queues: `{ projectSlug: "my-app", stateType: "queue", search: "auth" }`
- View completed work: `{ projectSlug: "my-app", stateType: "terminal" }`

**Note:** When browsing terminal states (Done), the tool queries closed issues from the provider.

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

Manual trigger for heartbeat: health fix + review polling + queue dispatch. Same logic as the background heartbeat service, but invoked on demand.

**Source:** [`lib/tools/work-heartbeat.ts`](../lib/tools/work-heartbeat.ts)

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectGroupId` | string | No | Target single project. Omit for all. |
| `dryRun` | boolean | No | Report only, don't dispatch. Default: `false`. |
| `maxPickups` | number | No | Max worker dispatches per tick. |
| `activeSessions` | string[] | No | Active session IDs for zombie detection. |

**Three-pass sweep:**

1. **Health pass** — Runs `checkWorkerHealth` per project per role. Auto-fixes zombies, stale workers, orphaned state.
2. **Review pass** — Polls PR status for issues in "To Review" state. Auto-merges and transitions to Done (or "To Test" if test phase enabled) when PR is approved. PR comments or changes-requested reviews transition to "To Improve".
3. **Tick pass** — Calls `projectTick` per project. Fills free worker slots by priority (To Improve > To Review > To Do).

**Execution guards:**

- `projectExecution: "sequential"` — only one project active at a time
- `roleExecution: "sequential"` — only one role active at a time per project

---

## Setup

### `project_register`

One-time project setup. Creates state labels, scaffolds project directory with override instructions, adds project to state.

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
| `roleExecution` | `"parallel"` \| `"sequential"` | No | DEVELOPER/TESTER parallelism. Default: `"parallel"`. |

**What it does atomically:**

1. Validates project not already registered
2. Resolves repo path, auto-detects GitHub/GitLab from git remote
3. Verifies provider health (CLI installed and authenticated)
4. Creates all 11 state labels (idempotent — safe to run again)
5. Adds project entry to `projects.json` with empty worker state for all registered roles
6. Scaffolds project directory with `prompts/` folder and `README.md` explaining prompt and workflow overrides
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
| `models` | object | No | Model overrides per role and level (see [Configuration](CONFIGURATION.md#role-configuration)) |
| `projectExecution` | `"parallel"` \| `"sequential"` | No | Project execution mode |

**What it does:**

1. Creates a new agent or configures existing workspace
2. Optionally binds messaging channel (Telegram/WhatsApp)
3. Optionally migrates channel binding from another agent
4. Writes workspace files: AGENTS.md, HEARTBEAT.md, IDENTITY.md, TOOLS.md, SOUL.md, `devclaw/projects.json`, `devclaw/workflow.yaml`
5. Scaffolds default prompt files for all roles

---

### `onboard`

Conversational onboarding guide. Returns step-by-step instructions for the agent to walk the user through setup.

**Source:** [`lib/tools/onboard.ts`](../lib/tools/onboard.ts)

**Note:** Call this before `setup` to get step-by-step guidance.

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `mode` | `"first-run"` \| `"reconfigure"` | No | Auto-detected from current state |

---

### `workflow_guide`

Reference guide for workflow configuration. Call before making any workflow changes.

**Source:** [`lib/tools/workflow-guide.ts`](../lib/tools/workflow-guide.ts)

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `topic` | string | No | Narrow to: `overview`, `states`, `roles`, `review`, `testing`, `timeouts`, `overrides`. Omit for full guide. |

**Returns:** Comprehensive documentation about the workflow config structure, valid values (enums vs free-form), config layer system, and common customization recipes.

**Use cases:**

- User asks to change review policy → call `workflow_guide` first, then edit `workflow.yaml`
- User asks to enable test phase → call `workflow_guide("testing")` for step-by-step
- User asks about config options → call `workflow_guide("overview")` for the full picture

---

### `research_task`

Spawn an architect for a design investigation. Creates a Planning issue with rich context and dispatches an architect worker. No queue states — tool-triggered only.

**Source:** [`lib/tools/research-task.ts`](../lib/tools/research-task.ts)

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectGroupId` | string | Yes | Project group ID |
| `title` | string | Yes | Design task title |
| `description` | string | Yes | Detailed background context for the architect |
| `focusAreas` | string[] | No | Specific areas to investigate |
| `complexity` | `"simple"` \| `"medium"` \| `"complex"` | No | Guides level selection. Default: `"medium"`. |

---

## Completion Rules Reference

The pipeline service (`lib/services/pipeline.ts`) derives completion rules from the workflow config.

**Default flow (human review, no test phase):**

```
developer:done    → Doing     → To Review    (detect PR, heartbeat polls PR status)
developer:blocked → Doing     → Refining     (awaits human decision)
reviewer:approve  → Reviewing → Done         (merge PR, git pull, close issue)
reviewer:reject   → Reviewing → To Improve   (sent back to developer)
reviewer:blocked  → Reviewing → Refining     (awaits human decision)
architect:done    → stays in Planning          (design complete, ready for human review)
architect:blocked → Planning  → Refining      (awaits human decision)
```

**With test phase enabled:**

```
tester:pass       → Testing   → Done         (close issue)
tester:fail       → Testing   → To Improve   (reopen issue)
tester:refine     → Testing   → Refining     (awaits human decision)
tester:blocked    → Testing   → Refining     (awaits human decision)
```

**Heartbeat auto-transitions (on "To Review" state):**

```
PR approved       → To Review → Done         (merge PR, git pull, close issue)
PR comments       → To Review → To Improve   (developer fixes)
Merge conflict    → To Review → To Improve   (developer resolves)
```

## Issue Priority Order

When the heartbeat or `work_heartbeat` fills free worker slots, issues are prioritized:

1. **To Improve** — Review failures get fixed first (highest priority)
2. **To Review** — Completed developer work awaits review (priority 2)
3. **To Do** — Fresh tasks are picked up last

This ensures the pipeline clears its backlog before starting new work.
