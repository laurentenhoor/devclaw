# DevClaw 1.3.0 — The Workflow Release

58 commits. 4 roles. A fully configurable state machine. And the default workflow finally makes sense.

---

## The big stuff

### Your workflow is now yours

The entire issue lifecycle is a state machine you define in `workflow.yaml`. States, transitions, actions, review checks — all configurable. The default is dead simple:

```
Planning → To Do → Doing → To Review → PR approved → Done
```

Human review, no test phase, auto-merge on approval. That's it. When you're ready for more, uncomment the test phase, switch to agent review, or build something entirely custom. Three-layer config (built-in → workspace → project) means you can override per-project without touching global settings.

### Architects

Not everything is a code task. `research_task` spawns an architect that investigates, posts findings as issue comments, and hands back to you. No PR, no queue — just research → findings → your decision. Junior (Sonnet) for straightforward investigations, senior (Opus) for the hard stuff.

### The PR feedback loop actually works now

This was the missing piece. Before 1.3, if someone left a review comment or requested changes, nothing happened automatically. Now:

- PR approved → auto-merge, issue closed, next task picked up
- Changes requested → issue moves to "To Improve", DEV gets dispatched with the review context
- PR comment with feedback → same thing, with 👀 reaction so you know it was processed
- Merge conflict → back to DEV with context

The heartbeat drives all of this. No orchestrator tokens spent.

### Everything is configurable, nothing is hardcoded

- **Roles** — dynamic registry. Developer, tester, architect, reviewer ship built-in. Adding a new role is one registry entry.
- **Models** — override per role, per level, per project. `workflow.yaml` → `roles.developer.models.senior: your-model-here`
- **States** — add, remove, rename. Queue states get auto-dispatched, hold states pause for humans, terminal states close things out.
- **Review policy** — `human` (GitHub/GitLab approval), `agent` (AI reviewer), `auto` (hybrid). Per-issue override with labels.
- **Multiple channels per project** — same project, different notification groups. Multi-group isolation via `notify:{groupId}` labels keeps the right people in the loop.

---

## New tools

| Tool | What |
|---|---|
| `research_task` | Spawn an architect for design investigation |
| `workflow_guide` | Interactive config reference — call before editing workflow.yaml |
| `autoconfigure_models` | LLM-powered model selection based on what's available |
| `task_edit_body` | Edit issue title/description (Planning state only, audit-logged) |

14 tools total (was 11).

---

## Under the hood

- **Provider resilience** — all GitHub/GitLab calls now retry with exponential backoff + circuit breaker. No more single-failure cascades.
- **Bootstrap hook** — role instructions injected at session startup via `agent:bootstrap`, not appended to task messages. Cleaner, no audit noise.
- **Project-first schema** — `projects.json` restructured with project as the top-level key. Auto-migrates from old format.
- **Orphaned session cleanup** — health pass finds and cleans up zombie subagent sessions.
- **GitHub timeline API** — more reliable PR detection for issue linking.
- **Inline markdown links** everywhere. Telegram link previews disabled by default (configurable).

---

## Breaking changes

None that require manual intervention. Schema migrations run automatically. But be aware:

- `design_task` → renamed to `research_task`
- QA role → renamed to Tester
- Group IDs → project slugs across all tools
- Workspace data directory → `<workspace>/devclaw/` (was `<workspace>/projects/`)
- Default review policy → `human` (was `auto`)
- Default workflow → no test phase (was included)

All migrations are automatic. Existing `workflow.yaml` files are not overwritten.

---

## Fixes

- PR comment detection actually works (was checking for non-existent "robot" emoji)
- Self-merged PRs can't bypass `review:human` anymore
- Health pass no longer kills workers it shouldn't
- GitLab approval detection replaced with merge status (more reliable)
- Heartbeat only auto-merges PRs that are supposed to be auto-merged

---

## Docs

Fully rewritten for 1.3.0. New [Workflow Reference](docs/WORKFLOW.md) covers the state machine, review policies, and test phase in one place. All cross-references updated.

---

## Install / upgrade

```bash
openclaw plugins install @laurentenhoor/devclaw
```

Full changelog: [CHANGELOG.md](CHANGELOG.md)
