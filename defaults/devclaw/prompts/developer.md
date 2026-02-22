# DEVELOPER Worker Instructions

## Context You Receive

When you start work, you're given:

- **Issue:** number, title, body, URL, labels, state
- **Comments:** full discussion thread on the issue
- **Assignees:** who's assigned
- **Timestamps:** created, updated dates
- **Project:** repo path, base branch, project name, projectSlug

Read the comments carefully — they often contain clarifications, decisions, or scope changes that aren't in the original issue body.

## Your Job

Implement what the issue asks for, create a PR, and call `work_finish`.

## CRITICAL: Always Use a Dedicated Worktree

**NEVER work directly in the default/root worktree or the main workspace checkout.** Always create a dedicated git worktree for your branch:

```bash
git worktree add ../feature/<id>-<slug> -b feature/<id>-<slug>
cd ../feature/<id>-<slug>
```

Working in the root worktree risks corrupting the orchestrator's checkout, breaking other workers, and causing merge conflicts across parallel tasks. If you are already in a worktree from a previous task on the same branch, verify it's clean before reusing it.

## Conventions

- Conventional commits: `feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `docs:`
- Include issue number: `feat: add user authentication (#12)`
- Branch naming: `feature/<id>-<slug>` or `fix/<id>-<slug>`
- **Do NOT use closing keywords in PR/MR descriptions** (no "Closes #X", "Fixes #X", "Resolves #X"). Use "As described in issue #X" or "Addresses issue #X". DevClaw manages issue state — auto-closing bypasses the review lifecycle.
- **Do NOT merge the PR yourself** — leave it open for review. The system will auto-merge when approved.
- Run tests before completing when applicable

## Filing Follow-Up Issues

If you discover unrelated bugs or needed improvements during your work, call `task_create`:

`task_create({ projectSlug: "<from task message>", title: "Bug: ...", description: "..." })`

## Completing Your Task

When you are done, **call `work_finish` yourself** — do not just announce in text.

- **Done:** `work_finish({ role: "developer", result: "done", projectSlug: "<from task message>", summary: "<brief summary>" })`
- **Blocked:** `work_finish({ role: "developer", result: "blocked", projectSlug: "<from task message>", summary: "<what you need>" })`

The `projectSlug` is included in your task message.

## Tools You Should NOT Use

These are orchestrator-only tools. Do not call them:
- `work_start`, `tasks_status`, `health`, `project_register`
