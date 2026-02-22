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

### Upgrade and Label Sync Tools

Two new maintenance tools: `upgrade` checks npm for newer versions, installs updates, and upgrades workspace files with `.bak` backups. `sync_labels` synchronizes GitHub/GitLab labels with the resolved workflow config after editing `workflow.yaml`.

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

---

## Planned

### Channel-agnostic Groups

Currently DevClaw maps projects to **Telegram group IDs**. The `projectGroupId` is a Telegram-specific negative number. This means:
- WhatsApp groups can't be used as project channels (partially supported now via `channel` field)
- Discord, Slack, or other channels are excluded
- The naming (`groupId`, `groupName`) is Telegram-specific

**Planned: abstract channel binding**

Replace Telegram-specific group IDs with a generic channel identifier that works across any OpenClaw channel.

```json
{
  "projects": {
    "whatsapp:120363140032870788@g.us": {
      "name": "my-project",
      "channel": "whatsapp",
      "peer": "120363140032870788@g.us"
    },
    "telegram:-1234567890": {
      "name": "other-project",
      "channel": "telegram",
      "peer": "-1234567890"
    }
  }
}
```

Key changes:
- `projectGroupId` becomes a composite key: `<channel>:<peerId>`
- `project_register` accepts `channel` + `peerId` instead of `projectGroupId`
- Project lookup uses the composite key from the message context
- All tool params, state keys, and docs updated accordingly
- Backward compatible: existing Telegram-only keys migrated on read

This enables any OpenClaw channel (Telegram, WhatsApp, Discord, Slack, etc.) to host a project.

#### Open questions

- Should one project be bindable to multiple channels? (e.g. Telegram for devs, WhatsApp for stakeholder updates)
- How does the orchestrator agent handle cross-channel context?

---

## Other Ideas

- **Jira provider** — `IssueProvider` interface already abstracts GitHub/GitLab; Jira is the obvious next addition
- **Deployment integration** — `work_finish` TESTER pass could trigger a deploy step via webhook or CLI
- **Cost tracking** — log token usage per task/level, surface in `status`
- **Priority scoring** — automatic priority assignment based on labels, age, and dependencies
- **Session archival** — auto-archive idle sessions after configurable timeout (currently indefinite)
- **Progressive delegation** — track TESTER pass rates per level and auto-promote (see [Management Theory](MANAGEMENT.md))
- **Custom workflow actions** — user-defined actions in `workflow.yaml` (e.g. deploy scripts, notifications)
