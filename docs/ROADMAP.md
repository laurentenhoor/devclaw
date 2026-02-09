# DevClaw — Roadmap

## Configurable Roles

Currently DevClaw has two hardcoded roles: **DEV** and **QA**. Each project gets one worker slot per role. The pipeline is fixed: DEV writes code, QA reviews it.

This works for the common case but breaks down when you want:
- A **design** role that creates mockups before DEV starts
- A **devops** role that handles deployment after QA passes
- A **PM** role that triages and prioritizes the backlog
- Multiple DEV workers in parallel (e.g. frontend + backend)
- A project with no QA step at all

### Planned: role configuration per project

Roles become a configurable list instead of a hardcoded pair. Each role defines:
- **Name** — e.g. `design`, `dev`, `qa`, `devops`
- **Tiers** — which developer tiers can be assigned (e.g. design only needs `medior`)
- **Pipeline position** — where it sits in the task lifecycle
- **Worker count** — how many concurrent workers (default: 1)

```json
{
  "roles": {
    "dev": { "tiers": ["junior", "medior", "senior"], "workers": 1 },
    "qa": { "tiers": ["qa"], "workers": 1 },
    "devops": { "tiers": ["medior", "senior"], "workers": 1 }
  },
  "pipeline": ["dev", "qa", "devops"]
}
```

The pipeline definition replaces the hardcoded `Doing → To Test → Testing → Done` flow. Labels and transitions are generated from the pipeline config. Auto-chaining follows the pipeline order.

### Open questions

- How do custom labels map? Generate from role names, or let users define?
- Should roles have their own instruction files (`roles/<project>/<role>.md`) — yes, this already works
- How to handle parallel roles (e.g. frontend + backend DEV in parallel before QA)?

---

## Channel-agnostic groups

Currently DevClaw maps projects to **Telegram group IDs**. The `projectGroupId` is a Telegram-specific negative number. This means:
- WhatsApp groups can't be used as project channels
- Discord, Slack, or other channels are excluded
- The naming (`groupId`, `groupName`) is Telegram-specific

### Planned: abstract channel binding

Replace Telegram-specific group IDs with a generic channel identifier that works across any OpenClaw channel.

```json
{
  "projects": {
    "whatsapp:120363140032870788@g.us": {
      "name": "my-project",
      "channel": "whatsapp",
      "peer": "120363140032870788@g.us",
      ...
    },
    "telegram:-1234567890": {
      "name": "other-project",
      "channel": "telegram",
      "peer": "-1234567890",
      ...
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

This enables any OpenClaw channel (Telegram, WhatsApp, Discord, Slack, etc.) to host a project — each group chat becomes an autonomous dev team regardless of platform.

### Open questions

- Should one project be bindable to multiple channels? (e.g. Telegram for devs, WhatsApp for stakeholder updates)
- How does the orchestrator agent handle cross-channel context? (OpenClaw bindings already route by channel)

---

## Other ideas

- **Jira provider** — `IssueProvider` interface already abstracts GitHub/GitLab; Jira is the obvious next addition
- **Deployment integration** — `task_complete` QA pass could trigger a deploy step via webhook or CLI
- **Cost tracking** — log token usage per task/tier, surface in `queue_status`
- **Priority scoring** — automatic priority assignment based on labels, age, and dependencies
- **Session archival** — auto-archive idle sessions after configurable timeout (currently indefinite)
