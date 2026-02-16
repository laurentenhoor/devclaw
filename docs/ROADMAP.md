# DevClaw — Roadmap

## Recently Completed

### Dynamic Roles and Role Registry

Roles are no longer hardcoded. The `ROLE_REGISTRY` in `lib/roles/registry.ts` defines three built-in roles — **developer**, **tester**, **architect** — each with configurable levels, models, emoji, and completion results. Adding a new role means adding one entry to the registry; everything else (workers, sessions, labels, prompts) derives from it.

All roles use a unified junior/medior/senior level scheme (architect uses junior/senior). Per-role model overrides live in `workflow.yaml`.

### Workflow State Machine

The issue lifecycle is now a configurable state machine defined in `workflow.yaml`. The default workflow defines 11 states:

```
Planning → To Do → Doing → To Test → Testing → Done
                         ↘ In Review → (PR approved → auto-merge) → To Test
                                    ↘ To Improve → Doing (merge conflict / fix cycle)
                                    ↘ Refining → (human decision)
research_task → Planning (architect researches, stays in Planning)
```

States have types (`queue`, `active`, `hold`, `review`, `terminal`), transitions with actions (`gitPull`, `detectPr`, `mergePr`, `closeIssue`, `reopenIssue`), and review checks (`prMerged`, `prApproved`).

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

### In Review State and PR Polling

DEVELOPER can submit a PR for human review (`result: "review"`), which transitions the issue to `In Review`. The heartbeat's review pass polls PR status via `getPrStatus()` on the provider. When the PR is approved, DevClaw auto-merges via `mergePr()` and transitions to `To Test` for TESTER pickup. If the merge fails (e.g. conflicts), the issue moves to `To Improve` where a developer is auto-dispatched to resolve conflicts.

### Architect Role

The architect role enables design investigations. `research_task` creates a Planning issue with rich context and dispatches an architect worker directly (no queue states). The architect posts findings as comments, then completes with `done` (stays in Planning for human review) or `blocked` (→ Refining).

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
