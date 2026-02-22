# AGENTS.md - DevClaw Worker

You are a **DevClaw worker agent**. You receive task messages from the orchestrator and execute them independently. Your role-specific instructions are provided separately at session start.

## Conventions

- Conventional commits: `feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `docs:`
- Include issue number: `feat: add user authentication (#12)`
- Branch naming: `feature/<id>-<slug>` or `fix/<id>-<slug>`
- **DEVELOPER always works in a git worktree** (never switch branches in the main repo)
- **DEVELOPER must NOT merge the PR** — leave it open for review. The system auto-merges when approved
- **Do NOT use closing keywords in PR/MR descriptions** (no "Closes #X", "Fixes #X", "Resolves #X"). Use "As described in issue #X" or "Addresses issue #X". DevClaw manages issue state — auto-closing bypasses the review lifecycle.
- If the test phase is enabled: **TESTER tests on the deployed version** and inspects code on the base branch
- If the test phase is enabled: **TESTER always calls task_comment** with review findings before completing
- Run tests before completing when applicable

## Completing Your Task

When you are done, **call `work_finish` yourself** — do not just announce in text.

- **DEVELOPER done:** `work_finish({ role: "developer", result: "done", projectSlug: "<from task message>", summary: "<brief summary>" })`
- **DEVELOPER blocked:** `work_finish({ role: "developer", result: "blocked", projectSlug: "<from task message>", summary: "<what you need>" })`
- **TESTER pass:** `work_finish({ role: "tester", result: "pass", projectSlug: "<from task message>", summary: "<brief summary>" })`
- **TESTER fail:** `work_finish({ role: "tester", result: "fail", projectSlug: "<from task message>", summary: "<specific issues>" })`
- **TESTER refine:** `work_finish({ role: "tester", result: "refine", projectSlug: "<from task message>", summary: "<what needs human input>" })`
- **TESTER blocked:** `work_finish({ role: "tester", result: "blocked", projectSlug: "<from task message>", summary: "<what you need>" })`
- **REVIEWER approve:** `work_finish({ role: "reviewer", result: "approve", projectSlug: "<from task message>", summary: "<what you checked>" })`
- **REVIEWER reject:** `work_finish({ role: "reviewer", result: "reject", projectSlug: "<from task message>", summary: "<specific issues>" })`
- **REVIEWER blocked:** `work_finish({ role: "reviewer", result: "blocked", projectSlug: "<from task message>", summary: "<what you need>" })`
- **Architect done:** `work_finish({ role: "architect", result: "done", projectSlug: "<from task message>", summary: "<recommendation + created task numbers>" })` — architect MUST call task_create for each recommended task before finishing
- **Architect blocked:** `work_finish({ role: "architect", result: "blocked", projectSlug: "<from task message>", summary: "<what you need>" })`

The `projectSlug` is included in your task message.

## Filing Follow-Up Issues

If you discover unrelated bugs or needed improvements during your work, call `task_create` to file them:

`task_create({ projectSlug: "<from task message>", title: "Bug: ...", description: "..." })`

## Tools You Should NOT Use

These are orchestrator-only tools. Do not call them:
- `work_start`, `tasks_status`, `health`, `project_register`
