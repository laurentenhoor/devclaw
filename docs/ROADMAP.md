# DevClaw — Roadmap

## Recently Completed

### Dynamic Roles and Role Registry

Roles are no longer hardcoded. The `ROLE_REGISTRY` in `lib/roles/registry.ts` defines three built-in roles — **developer**, **tester**, **architect** — each with configurable levels, models, emoji, and completion results. Adding a new role means adding one entry to the registry; everything else (workers, sessions, labels, prompts) derives from it.

All roles use a unified junior/medior/senior level scheme (architect uses junior/senior). Per-role model overrides live in `workflow.yaml`.

### Workflow State Machine

The issue lifecycle is now a configurable state machine defined in `workflow.yaml`. The default workflow uses **human review** with **no test phase** (10 default states, 12 with test phase):

```
Planning → To Do → Doing → To Review → [PR approved → auto-merge] → Done
                                      → PR comments/changes requested → To Improve → Doing
                                      → Refining → (human decision)
To Research → Researching → Planning (architect posts findings)
```

States have types (`queue`, `active`, `hold`, `terminal`), transitions with actions (`gitPull`, `detectPr`, `mergePr`, `closeIssue`, `reopenIssue`), and review checks (`prMerged`, `prApproved`). The test phase (toTest, testing) can be enabled via `workflow.yaml` — see [Workflow](WORKFLOW.md#test-phase-optional).

### Three-Layer Configuration

Config resolution follows three layers, each partially overriding the one below:

1. **Built-in defaults** — `ROLE_REGISTRY` + `DEFAULT_WORKFLOW`
2. **Workspace** — `<workspace>/devclaw/workflow.yaml`
3. **Project** — `<workspace>/devclaw/projects/<project>/workflow.yaml`

Validated at load time with Zod schemas (`lib/config/schema.ts`). Integrity checks verify transition targets exist, queue states have roles, and terminal states have no outgoing transitions.

### Provider Resilience

All issue tracker calls (GitHub via `gh`, GitLab via `glab`) are wrapped with cockatiel retry (3 attempts, exponential backoff) and circuit breaker (opens after 5 consecutive failures, half-opens after 30s). See `lib/providers/resilience.ts`.

### Bootstrap Hook for Role Instructions

Worker sessions receive role-specific instructions via the `agent:bootstrap` hook at session startup, not appended to the task message. The hook reads from `devclaw/projects/<project>/prompts/<role>.md`, falling back to `devclaw/prompts/<role>.md`. Supports source tracking with `loadRoleInstructions(dir, { withSource: true })`.

### PR Review and Auto-Merge

DEVELOPER completes work (`result: "done"`), which transitions the issue to `To Review`. The heartbeat's review pass polls PR status via `getPrStatus()` on the provider. When the PR is approved, DevClaw auto-merges via `mergePr()` and transitions to `Done` (or `To Test` if test phase enabled). If the PR receives changes-requested reviews or merge conflicts, the issue moves to `To Improve` where a developer is auto-dispatched to fix.

### Architect Role

The architect role enables design investigations. `research_task` creates an issue and dispatches an architect worker through dedicated `To Research` → `Researching` states. The architect posts findings as comments, creates implementation tasks in Planning, then completes with `done` or `blocked` (→ Refining).

### Slot-Based Worker Pools

Workers now support multiple concurrent slots per role level via `maxWorkers` / `maxWorkersPerLevel` in `workflow.yaml`. The data model (`WorkerState`), dispatch engine (`tick.ts`, `work-start.ts`), health checks, status dashboard, and project registration all support multi-slot workers. Session keys use slot-indexed naming for isolation.

### Label Sync Tool

`sync_labels` synchronizes GitHub/GitLab labels with the resolved workflow config after editing `workflow.yaml`.

### PR Closure and Rejection Handling

Closing a PR without merging now transitions the associated issue to `Rejected` state with proper issue closure. The workflow state machine supports a new `PR_CLOSED` event in transitions.

### Workspace Layout Migration

Data directory moved from `<workspace>/projects/` to `<workspace>/devclaw/`. Automatic migration on first load — see `lib/setup/migrate-layout.ts`.

### E2E Test Infrastructure

Purpose-built test harness (`lib/testing/`) with:
- `TestProvider` — in-memory `IssueProvider` with call tracking
- `createTestHarness()` — scaffolds temp workspace, mock `runCommand`, test provider
- `simulateBootstrap()` — tests the full bootstrap hook chain without a live gateway
- `CommandInterceptor` — captures and filters CLI calls

### Channel Management Tools

Three new tools for managing project-to-channel bindings: `channel_link` (attach a chat to a project, auto-detaches previous), `channel_unlink` (remove a channel from a project), and `channel_list` (list channels for a project or all projects). Projects can now have multiple notification channels.

### Version Tracking and Config Management

Write-once defaults with version tracking — the plugin only writes workspace files (prompts, workflow.yaml) when the package version changes and the user hasn't customized them. The `config` tool provides three actions: `reset` (reset to package defaults with `.bak` backups), `diff` (compare current workflow.yaml against the default template), and `version` (show package and workspace versions).

### Structural Refactoring

Major module reorganization for better separation of concerns:
- `lib/dispatch/` — dispatch, bootstrap hook, attachment hook, notifications
- `lib/tools/tasks/`, `lib/tools/admin/`, `lib/tools/worker/` — tool grouping by domain
- `lib/services/heartbeat/` — heartbeat passes split into separate modules
- `lib/projects/` — project state I/O, mutations, slots, types
- `lib/workflow/` — state machine types, defaults, labels, queries
- `lib/context.ts` — `PluginContext` DI container replacing global singletons

### Additional Tools

- `project_status` — instant local project info (registration, channels, workers, config) with no API calls
- `task_owner` — claim issue ownership for multi-instance deployments via `owner:{instanceName}` labels
- `config` — workspace config management (reset, diff, version)

### Reviewer Role

Fourth built-in role with dedicated `Reviewing` state. Reviewers check PRs and call `work_finish` with approve/reject/blocked. Default levels: junior (Haiku) and senior (Sonnet).

---

## Planned

### Channel-agnostic Groups

Replace Telegram-specific group IDs with a generic channel identifier that works across any OpenClaw channel. The `channelId` parameter is already used in new tools — the remaining work is migrating older tools and state keys.

Key changes remaining:
- Migrate `projectGroupId` in older tool signatures
- Update state keys in `projects.json`
- Backward-compatible migration on read

---

## Other Ideas

- **Jira provider** — `IssueProvider` interface already abstracts GitHub/GitLab; Jira is the obvious next addition
- **Deployment integration** — `work_finish` TESTER pass could trigger a deploy step via webhook or CLI
- **Cost tracking** — log token usage per task/level, surface in `status`
- **Priority scoring** — automatic priority assignment based on labels, age, and dependencies
- **Session archival** — auto-archive idle sessions after configurable timeout (currently indefinite)
- **Progressive delegation** — track TESTER pass rates per level and auto-promote (see [Management Theory](MANAGEMENT.md))
- **Custom workflow actions** — user-defined actions in `workflow.yaml` (e.g. deploy scripts, notifications)
