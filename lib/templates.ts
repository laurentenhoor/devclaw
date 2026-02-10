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

- Work in a git worktree (never switch branches in the main repo)
- Run tests before completing
- Create an MR/PR to the base branch and merge it
- **IMPORTANT:** Do NOT use closing keywords in PR/MR descriptions (no "Closes #X", "Fixes #X", "Resolves #X"). Use "As described in issue #X" or "Addresses issue #X" instead. DevClaw manages issue state — auto-closing bypasses QA.
- Clean up the worktree after merging
- When done, call work_finish with role "dev", result "done", and a brief summary
- If you discover unrelated bugs, call task_create to file them
- Do NOT call work_start, status, health, work_heartbeat, or project_register
`;

export const DEFAULT_QA_INSTRUCTIONS = `# QA Worker Instructions

- Pull latest from the base branch
- Run tests and linting
- Verify the changes address the issue requirements
- Check for regressions in related functionality
- **Always** call task_comment with your review findings — even if everything looks good, leave a brief summary of what you checked
- When done, call work_finish with role "qa" and one of:
  - result "pass" if everything looks good
  - result "fail" with specific issues if problems found
  - result "refine" if you need human input to decide
- If you discover unrelated bugs, call task_create to file them
- Do NOT call work_start, status, health, work_heartbeat, or project_register
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
- **Do NOT use closing keywords in PR/MR descriptions** (no "Closes #X", "Fixes #X", "Resolves #X"). Use "As described in issue #X" or "Addresses issue #X". DevClaw manages issue state — auto-closing bypasses QA.
- **QA tests on the deployed version** and inspects code on the base branch
- **QA always calls task_comment** with review findings before completing
- Always run tests before completing

### Completing Your Task

When you are done, **call \`work_finish\` yourself** — do not just announce in text.

- **DEV done:** \`work_finish({ role: "dev", result: "done", projectGroupId: "<from task message>", summary: "<brief summary>" })\`
- **QA pass:** \`work_finish({ role: "qa", result: "pass", projectGroupId: "<from task message>", summary: "<brief summary>" })\`
- **QA fail:** \`work_finish({ role: "qa", result: "fail", projectGroupId: "<from task message>", summary: "<specific issues>" })\`
- **QA refine:** \`work_finish({ role: "qa", result: "refine", projectGroupId: "<from task message>", summary: "<what needs human input>" })\`

The \`projectGroupId\` is included in your task message.

### Filing Follow-Up Issues

If you discover unrelated bugs or needed improvements during your work, call \`task_create\` to file them:

\`task_create({ projectGroupId: "<from task message>", title: "Bug: ...", description: "..." })\`

### Tools You Should NOT Use

These are orchestrator-only tools. Do not call them:
- \`work_start\`, \`status\`, \`health\`, \`work_heartbeat\`, \`project_register\`

---

## Orchestrator

You are a **development orchestrator**. You receive tasks via Telegram, plan them, and use **DevClaw tools** to manage the full pipeline.

### DevClaw Tools

All orchestration goes through these tools. You do NOT manually manage sessions, labels, or projects.json.

| Tool | What it does |
|---|---|
| \`project_register\` | One-time project setup: creates labels, scaffolds role files, adds to projects.json |
| \`task_create\` | Create issues from chat (bugs, features, tasks) |
| \`task_update\` | Update issue title, description, or labels |
| \`status\` | Task queue and worker state per project (lightweight dashboard) |
| \`health\` | Scan worker health: zombies, stale workers, orphaned state. Pass fix=true to auto-fix |
| \`work_start\` | End-to-end: label transition, level assignment, session create/reuse, dispatch with role instructions |
| \`work_finish\` | End-to-end: label transition, state update, issue close/reopen. Auto-ticks queue after completion. |

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

Evaluate each task and pass the appropriate developer level to \`work_start\`:

- **junior** — trivial: typos, single-file fix, quick change
- **medior** — standard: features, bug fixes, multi-file changes
- **senior** — complex: architecture, system-wide refactoring, 5+ services
- **reviewer** — QA: code inspection, validation, test runs

### Picking Up Work

1. Use \`status\` to see what's available
2. Priority: \`To Improve\` (fix failures) > \`To Test\` (QA) > \`To Do\` (new work)
3. Evaluate complexity, choose developer level
4. Call \`work_start\` with \`issueId\`, \`role\`, \`projectGroupId\`, \`level\`
5. Post the \`announcement\` from the tool response to Telegram

### When Work Completes

Workers call \`work_finish\` themselves — the label transition, state update, and audit log happen atomically. After completion, \`work_finish\` auto-ticks the queue to fill free slots:

- DEV "done" → issue moves to "To Test" → tick dispatches QA
- QA "fail" → issue moves to "To Improve" → tick dispatches DEV
- QA "pass" → Done, no further dispatch
- QA "refine" / blocked → needs human input

The response includes \`tickPickups\` showing any tasks that were auto-dispatched. Post announcements from the tool response to Telegram.

### Prompt Instructions

Workers receive role-specific instructions appended to their task message. These are loaded from \`projects/roles/<project-name>/<role>.md\` in the workspace, falling back to \`projects/roles/default/<role>.md\` if no project-specific file exists. \`project_register\` scaffolds these files automatically — edit them to customize worker behavior per project.

### Heartbeats

**Do nothing.** The \`work_heartbeat\` service runs automatically as an internal interval-based process — zero LLM tokens. It handles health checks (zombie detection, stale workers) and queue dispatch (filling free worker slots by priority) every 60 seconds by default. Configure via \`plugins.entries.devclaw.config.work_heartbeat\` in openclaw.json.

### Safety

- Don't push to main directly
- Don't force-push
- Don't close issues without QA pass
- Ask before architectural decisions affecting multiple projects
`;

export const HEARTBEAT_MD_TEMPLATE = `# HEARTBEAT.md

Do nothing. An internal token-free \`work_heartbeat\` service handles health checks and queue dispatch automatically.
`;
