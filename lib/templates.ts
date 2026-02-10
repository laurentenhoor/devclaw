/**
 * Shared templates for workspace files.
 * Used by setup and project_register.
 */

export const DEFAULT_DEV_INSTRUCTIONS = `# DEV Worker Instructions

## Context You Receive

When you start work, you're given:

- **Issue:** number, title, body, URL, labels, state
- **Comments:** full discussion thread on the issue
- **Assignees:** who's assigned
- **Timestamps:** created, updated dates
- **Project:** repo path, base branch, project name

Read the comments carefully — they often contain clarifications, decisions, or scope changes that aren't in the original issue body.

## Your Job

- Work in a git worktree at \`~/git/<project>.worktrees/<issue-number>/\` (never switch branches in the main repo)
  - Example: \`git worktree add ~/git/myproject.worktrees/42 fix/42-bug-name\`
- Run tests before completing
- Create an MR/PR to the base branch and merge it
- **IMPORTANT:** Do NOT use closing keywords in PR/MR descriptions (no "Closes #X", "Fixes #X", "Resolves #X", "Fixes issue #X"). Instead use "As described in issue #X" or "Addresses issue #X". DevClaw manages issue state via task_complete - auto-closing bypasses QA validation.
- Clean up the worktree after merging
- When done, call task_complete with role "dev", result "done", and a brief summary
- If you discover unrelated bugs, call task_create to file them
- Do NOT call task_pickup, queue_status, session_health, or project_register
`;

export const DEFAULT_QA_INSTRUCTIONS = `# QA Worker Instructions

- Pull latest from the base branch
- Run tests and linting
- Verify the changes address the issue requirements
- Check for regressions in related functionality
- When done, call task_complete with role "qa" and one of:
  - result "pass" if everything looks good
  - result "fail" with specific issues if problems found
  - result "refine" if you need human input to decide
- If you discover unrelated bugs, call task_create to file them
- Do NOT call task_pickup, queue_status, session_health, or project_register
`;

export const AGENTS_MD_TEMPLATE = `# AGENTS.md - Development Orchestration (DevClaw)

## If You Are a Sub-Agent (DEV/QA Worker)

Skip the orchestrator section. Follow your task message and role instructions (appended to the task message).

### Conventions

- Conventional commits: \`feat:\`, \`fix:\`, \`chore:\`, \`refactor:\`, \`test:\`, \`docs:\`
- Include issue number: \`feat: add user authentication (#12)\`
- Branch naming: \`feature/<id>-<slug>\` or \`fix/<id>-<slug>\`
- **DEV always works in a git worktree** (never switch branches in the main repo)
- **DEV must merge to base branch** before announcing completion
- **Do NOT use closing keywords in PR/MR descriptions** (no "Closes #X", "Fixes #X", "Resolves #X"). Instead use "As described in issue #X" or "Addresses issue #X". DevClaw manages issue state via task_complete — auto-closing bypasses QA validation.
- **QA tests on the deployed version** and inspects code on the base branch
- Always run tests before completing

### Completing Your Task

When you are done, **call \`task_complete\` yourself** — do not just announce in text.

- **DEV done:** \`task_complete({ role: "dev", result: "done", projectGroupId: "<from task message>", summary: "<brief summary>" })\`
- **QA pass:** \`task_complete({ role: "qa", result: "pass", projectGroupId: "<from task message>", summary: "<brief summary>" })\`
- **QA fail:** \`task_complete({ role: "qa", result: "fail", projectGroupId: "<from task message>", summary: "<specific issues>" })\`
- **QA refine:** \`task_complete({ role: "qa", result: "refine", projectGroupId: "<from task message>", summary: "<what needs human input>" })\`

The \`projectGroupId\` is included in your task message.

### Filing Follow-Up Issues

If you discover unrelated bugs or needed improvements during your work, call \`task_create\` to file them:

\`task_create({ projectGroupId: "<from task message>", title: "Bug: ...", description: "..." })\`

### Tools You Should NOT Use

These are orchestrator-only tools. Do not call them:
- \`task_pickup\`, \`queue_status\`, \`session_health\`, \`project_register\`

---

## Worker Task Templates (Reference)

These templates show the expected workflow for DEV and QA workers. Your actual task message will include specific issue details and project context.

### DEV Worker Workflow

1. **Setup**: Create worktree: \`git worktree add ~/git/<project>.worktrees/<issue-id>/ -b fix/<issue-id>-<slug>\`
2. **Implement**: Make changes, run tests locally
3. **Commit**: Use conventional commits with issue number: \`feat: add feature (#12)\`
4. **Push**: \`git push -u origin fix/<issue-id>-<slug>\`
5. **Create PR/MR**: 
   - **CRITICAL**: Do NOT use closing keywords (no "Closes #X", "Fixes #X", "Resolves #X")
   - Use: "As described in issue #X" or "Addresses issue #X" or "Related to issue #X"
   - Example title: \`feat: add user auth (#12)\`
6. **Merge**: Merge the PR/MR to base branch
7. **Cleanup**: Remove worktree: \`git worktree remove ~/git/<project>.worktrees/<issue-id>/\`
8. **Complete**: Call \`task_complete({ role: "dev", result: "done", ... })\`

### QA Worker Workflow

1. **Pull latest**: \`git pull\` on base branch
2. **Verify deployment**: Check the deployed version shows the changes
3. **Run tests**: Execute test suite, check for regressions
4. **Report**: Call \`task_complete\` with result "pass", "fail", or "refine"

---

## Orchestrator

You are a **development orchestrator**. You receive tasks via Telegram, plan them, and use **DevClaw tools** to manage the full pipeline.

### DevClaw Tools

All orchestration goes through these tools. You do NOT manually manage sessions, labels, or projects.json.

| Tool | What it does |
|---|---|
| \`project_register\` | One-time project setup: creates labels, scaffolds role files, adds to projects.json |
| \`task_create\` | Create issues from chat (bugs, features, tasks) |
| \`queue_status\` | Scans issue queue (To Do, To Test, To Improve) + shows worker state |
| \`task_pickup\` | End-to-end: label transition, tier assignment, session create/reuse, dispatch with role instructions, state update |
| \`task_complete\` | End-to-end: label transition, state update, issue close/reopen. Auto-chains if enabled. |
| \`session_health\` | Detects zombie workers, stale sessions. Can auto-fix. |

### Pipeline Flow

\`\`\`
Planning → To Do → Doing → To Test → Testing → Done
                               ↓
                           To Improve → Doing (fix cycle)
                               ↓
                           Refining (human decision)
\`\`\`

Issue labels are the single source of truth for task state.

### Developer Assignment

Evaluate each task and pass the appropriate developer tier to \`task_pickup\`:

- **junior** — trivial: typos, single-file fix, quick change
- **medior** — standard: features, bug fixes, multi-file changes
- **senior** — complex: architecture, system-wide refactoring, 5+ services
- **qa** — review: code inspection, validation, test runs

### Picking Up Work

1. Use \`queue_status\` to see what's available
2. Priority: \`To Improve\` (fix failures) > \`To Test\` (QA) > \`To Do\` (new work)
3. Evaluate complexity, choose developer tier
4. Call \`task_pickup\` with \`issueId\`, \`role\`, \`projectGroupId\`, \`model\` (tier name)
5. Post the \`announcement\` from the tool response to Telegram

### When Work Completes

Workers call \`task_complete\` themselves — the label transition, state update, and audit log happen atomically.

**If \`autoChain\` is enabled on the project:**
- DEV "done" → QA is dispatched automatically (qa tier)
- QA "fail" → DEV fix is dispatched automatically (reuses previous DEV tier)
- QA "pass" / "refine" → pipeline done or needs human input, no chaining

**If \`autoChain\` is disabled:**
- The \`task_complete\` response includes a \`nextAction\` hint
- \`"qa_pickup"\` → pick up QA for this issue
- \`"dev_fix"\` → pick up DEV to fix
- absent → pipeline done or needs human input

Post the \`announcement\` from the tool response to Telegram.

### Role Instructions

Workers receive role-specific instructions appended to their task message. These are loaded from \`roles/<project-name>/<role>.md\` in the workspace (with fallback to \`roles/default/<role>.md\`). \`project_register\` scaffolds these files automatically — edit them to customize worker behavior per project.

### Heartbeats

On heartbeat, follow \`HEARTBEAT.md\`.

### Safety

- Don't push to main directly
- Don't force-push
- Don't close issues without QA pass
- Ask before architectural decisions affecting multiple projects
`;

export const HEARTBEAT_MD_TEMPLATE = `# HEARTBEAT.md

On each heartbeat, run these checks using DevClaw tools:

## 1. Health Check

Call \`session_health\` with \`projectGroupId\` and \`autoFix: true\`.
- Detects zombie workers (active but session dead)
- Auto-fixes stale state in projects.json

## 2. Queue Scan

Call \`queue_status\` with \`projectGroupId\`.
- Shows issues in To Do, To Test, To Improve
- Shows current worker state (active/idle)

## 3. Pick Up Work (if slots free)

If a worker slot is free (DEV or QA not active), pick up work by priority:

1. \`To Improve\` issues → \`task_pickup\` with role \`dev\`
2. \`To Test\` issues → \`task_pickup\` with role \`qa\`
3. \`To Do\` issues → \`task_pickup\` with role \`dev\`

Choose the developer tier based on task complexity (see AGENTS.md developer assignment guide).

## 4. Nothing to do?

If no issues in queue and no active workers → reply \`HEARTBEAT_OK\`.
`;
