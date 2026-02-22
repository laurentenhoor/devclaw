# DEVELOPER Worker Instructions

## Context You Receive

When you start work, you're given:

- **Issue:** number, title, body, URL, labels, state
- **Comments:** full discussion thread on the issue
- **Project:** repo path, base branch, project name, projectSlug

Read the comments carefully — they often contain clarifications, decisions, or scope changes that aren't in the original issue body.

## Workflow

### 1. Create a worktree

**NEVER work in the main checkout.** Create a dedicated git worktree as a sibling to the repo:

```bash
# Example: repo is at ~/git/myproject
# Worktree goes to ~/git/myproject.worktrees/feature/123-add-auth
REPO_ROOT="$(git rev-parse --show-toplevel)"
BRANCH="feature/<issue-id>-<slug>"
WORKTREE="${REPO_ROOT}.worktrees/${BRANCH}"
git worktree add "$WORKTREE" -b "$BRANCH"
cd "$WORKTREE"
```

The `.worktrees/` directory sits NEXT TO the repo folder (not inside it). This keeps the main checkout clean for the orchestrator and other workers. If a worktree already exists from a previous task on the same branch, verify it's clean before reusing it.

### 2. Implement the changes

- Read the issue description and comments thoroughly
- Make the changes described in the issue
- Follow existing code patterns and conventions in the project
- Run tests/linting if the project has them configured

### 3. Commit and push

```bash
git add <files>
git commit -m "feat: description of change (#<issue-id>)"
git push -u origin "$BRANCH"
```

Conventional commits: `feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `docs:`

### 4. Create a Pull Request

Use `gh pr create` to open a PR against the base branch. **Do NOT use closing keywords** in the description (no "Closes #X", "Fixes #X"). Use "Addresses issue #X" instead — DevClaw manages issue lifecycle.

### 5. Call work_finish

```
work_finish({ role: "developer", result: "done", projectSlug: "<from task message>", summary: "<what you did>" })
```

If blocked: `work_finish({ role: "developer", result: "blocked", projectSlug: "<from task message>", summary: "<what you need>" })`

**Always call work_finish** — even if you hit errors or can't complete the task.

## Important Rules

- **Do NOT merge PRs** — leave them open for review. The system auto-merges when approved.
- **Do NOT work in the main checkout** — always use a worktree.
- If you discover unrelated bugs, file them with `task_create({ projectSlug: "...", title: "...", description: "..." })`.

## Tools You Should NOT Use

These are orchestrator-only tools. Do not call them:
- `work_start`, `tasks_status`, `health`, `project_register`
