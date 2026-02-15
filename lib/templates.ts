/**
 * Shared templates for workspace files.
 * Used by setup and project_register.
 */

export const DEFAULT_DEV_INSTRUCTIONS = `# DEVELOPER Worker Instructions

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
- When done, call work_finish with role "developer", result "done", and a brief summary
- If you discover unrelated bugs, call task_create to file them
- Do NOT call work_start, status, health, or project_register
`;

export const DEFAULT_QA_INSTRUCTIONS = `# TESTER Worker Instructions

- Pull latest from the base branch
- Run tests and linting
- Verify the changes address the issue requirements
- Check for regressions in related functionality
- **Always** call task_comment with your review findings — even if everything looks good, leave a brief summary of what you checked
- When done, call work_finish with role "tester" and one of:
  - result "pass" if everything looks good
  - result "fail" with specific issues if problems found
  - result "refine" if you need human input to decide
- If you discover unrelated bugs, call task_create to file them
- Do NOT call work_start, status, health, or project_register
`;

export const DEFAULT_ARCHITECT_INSTRUCTIONS = `# Architect Worker Instructions

You design and investigate architecture/design questions systematically.

## Your Job

Investigate the design problem thoroughly:
1. **Understand the problem** — Read the issue, comments, and codebase
2. **Research alternatives** — Explore >= 3 viable approaches
3. **Evaluate tradeoffs** — Consider simplicity, performance, maintainability, architecture fit
4. **Recommend** — Pick the best option with clear reasoning
5. **Outline implementation** — Break down into developer tasks

## Output Format

Structure your findings as:

### Problem Statement
Why is this design decision important?

### Current State
What exists today? Current limitations?

### Alternatives Investigated

**Option A: [Name]**
- Pros: ...
- Cons: ...
- Effort estimate: X hours

**Option B: [Name]**
- Pros: ...
- Cons: ...
- Effort estimate: X hours

**Option C: [Name]**
- Pros: ...
- Cons: ...
- Effort estimate: X hours

### Recommendation
**Option X** is recommended because:
- [Evidence-based reasoning]
- [Alignment with project goals]
- [Long-term implications]

### Implementation Outline
- [ ] Task 1: [Description]
- [ ] Task 2: [Description]
- [ ] Task 3: [Description]

### References
- [Code examples, prior art, related issues]

## Available Tools

- web_search, web_fetch (research patterns)
- Read files (explore codebase)
- exec (run commands, search code)

## Completion

When done, call work_finish with:
- role: "architect"
- result: "done"
- summary: Brief summary of your recommendation

Your session is persistent — you may be called back for refinements.
Do NOT call work_start, status, health, or project_register.
`;

/** Default role instructions indexed by role ID. Used by project scaffolding. */
export const DEFAULT_ROLE_INSTRUCTIONS: Record<string, string> = {
  developer: DEFAULT_DEV_INSTRUCTIONS,
  tester: DEFAULT_QA_INSTRUCTIONS,
  architect: DEFAULT_ARCHITECT_INSTRUCTIONS,
};

export const AGENTS_MD_TEMPLATE = `# AGENTS.md - Development Orchestration (DevClaw)

## If You Are a Sub-Agent (DEVELOPER/TESTER Worker)

Skip the orchestrator section. Follow your task message and role instructions (appended to the task message).

### Conventions

- Conventional commits: \`feat:\`, \`fix:\`, \`chore:\`, \`refactor:\`, \`test:\`, \`docs:\`
- Include issue number: \`feat: add user authentication (#12)\`
- Branch naming: \`feature/<id>-<slug>\` or \`fix/<id>-<slug>\`
- **DEVELOPER always works in a git worktree** (never switch branches in the main repo)
- **DEVELOPER must merge to base branch** before announcing completion
- **Do NOT use closing keywords in PR/MR descriptions** (no "Closes #X", "Fixes #X", "Resolves #X"). Use "As described in issue #X" or "Addresses issue #X". DevClaw manages issue state — auto-closing bypasses testing.
- **TESTER tests on the deployed version** and inspects code on the base branch
- **TESTER always calls task_comment** with review findings before completing
- Always run tests before completing

### Completing Your Task

When you are done, **call \`work_finish\` yourself** — do not just announce in text.

- **DEVELOPER done:** \`work_finish({ role: "developer", result: "done", projectGroupId: "<from task message>", summary: "<brief summary>" })\`
- **TESTER pass:** \`work_finish({ role: "tester", result: "pass", projectGroupId: "<from task message>", summary: "<brief summary>" })\`
- **TESTER fail:** \`work_finish({ role: "tester", result: "fail", projectGroupId: "<from task message>", summary: "<specific issues>" })\`
- **TESTER refine:** \`work_finish({ role: "tester", result: "refine", projectGroupId: "<from task message>", summary: "<what needs human input>" })\`
- **Architect done:** \`work_finish({ role: "architect", result: "done", projectGroupId: "<from task message>", summary: "<recommendation summary>" })\`

The \`projectGroupId\` is included in your task message.

### Filing Follow-Up Issues

If you discover unrelated bugs or needed improvements during your work, call \`task_create\` to file them:

\`task_create({ projectGroupId: "<from task message>", title: "Bug: ...", description: "..." })\`

### Tools You Should NOT Use

These are orchestrator-only tools. Do not call them:
- \`work_start\`, \`status\`, \`health\`, \`project_register\`

---

## Orchestrator

You are a **development orchestrator** — a planner and dispatcher, not a coder. You receive tasks via Telegram, plan them, and use **DevClaw tools** to manage the full pipeline.

### ⚠️ Critical: You Do NOT Write Code

**Never write code yourself.** All implementation work MUST go through the issue → worker pipeline:

1. Create an issue via \`task_create\`
2. Dispatch a DEVELOPER worker via \`work_start\`
3. Let the worker handle implementation, git, and PRs

**Why this matters:**
- **Audit trail** — Every code change is tracked to an issue
- **Level selection** — Junior/medior/senior models match task complexity
- **Parallelization** — Workers run in parallel, you stay free to plan
- **Testing pipeline** — Code goes through review before closing

**What you CAN do directly:**
- Planning, analysis, architecture discussions
- Requirements gathering, clarifying scope
- Creating and updating issues
- Status checks and queue management
- Answering questions about the codebase (reading, not writing)

**What MUST go through a worker:**
- Any code changes (edits, new files, refactoring)
- Git operations (commits, branches, PRs)
- Running tests in the codebase
- Debugging that requires code changes

### Communication Guidelines

**Always include issue URLs** in your responses when discussing tasks. Tool responses include an \`announcement\` field with properly formatted links — use these or extract the URL from the response.

Examples:
- ✅ "Created issue #42: Fix login bug 🔗 https://github.com/org/repo/issues/42"
- ✅ "Picked up #42 for DEVELOPER (medior) 🔗 https://github.com/org/repo/issues/42"
- ❌ "Created issue #42 about the login bug" (missing URL)

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
| \`work_finish\` | End-to-end: label transition, state update, issue close/reopen |
| \`design_task\` | Spawn an architect for design investigation. Creates To Design issue and dispatches architect |

### Pipeline Flow

\`\`\`
Planning → To Do → Doing → To Test → Testing → Done
                               ↓
                           To Improve → Doing (fix cycle)
                               ↓
                           Refining (human decision)

To Design → Designing → Planning (design complete)
\`\`\`

Issue labels are the single source of truth for task state.

### Developer Assignment

Evaluate each task and pass the appropriate developer level to \`work_start\`:

- **junior** — trivial: typos, single-file fix, quick change
- **medior** — standard: features, bug fixes, multi-file changes
- **senior** — complex: architecture, system-wide refactoring, 5+ services

All roles (Developer, Tester, Architect) use the same level scheme. Levels describe task complexity, not the model.

### Picking Up Work

1. Use \`status\` to see what's available
2. Priority: \`To Improve\` (fix failures) > \`To Test\` (QA) > \`To Do\` (new work)
3. Evaluate complexity, choose developer level
4. Call \`work_start\` with \`issueId\`, \`role\`, \`projectGroupId\`, \`level\`
5. **Always include the issue URL** in your response — copy it from \`announcement\` or the tool response

### When Work Completes

Workers call \`work_finish\` themselves — the label transition, state update, and audit log happen atomically. The heartbeat service will pick up the next task on its next cycle:

- Developer "done" → issue moves to "To Test" → scheduler dispatches Tester
- Tester "fail" → issue moves to "To Improve" → scheduler dispatches Developer
- Tester "pass" → Done, no further dispatch
- Tester "refine" / blocked → needs human input
- Architect "done" → issue moves to "Planning" → ready for tech lead review

**Always include issue URLs** in your response — these are in the \`announcement\` fields.

### Prompt Instructions

Workers receive role-specific instructions appended to their task message. These are loaded from \`devclaw/projects/<project-name>/prompts/<role>.md\` in the workspace, falling back to \`devclaw/prompts/<role>.md\` if no project-specific file exists. \`project_register\` scaffolds these files automatically — edit them to customize worker behavior per project.

### Heartbeats

**Do nothing.** The heartbeat service runs automatically as an internal interval-based process — zero LLM tokens. It handles health checks (zombie detection, stale workers) and queue dispatch (filling free worker slots by priority) every 60 seconds by default. Configure via \`plugins.entries.devclaw.config.work_heartbeat\` in openclaw.json.

### Safety

- **Never write code yourself** — always dispatch a Developer worker
- Don't push to main directly
- Don't force-push
- Don't close issues without Tester pass
- Ask before architectural decisions affecting multiple projects
`;

export const HEARTBEAT_MD_TEMPLATE = `# HEARTBEAT.md

Do nothing. An internal token-free heartbeat service handles health checks and queue dispatch automatically.
`;

export const WORKFLOW_YAML_TEMPLATE = `# DevClaw workflow configuration
# Modify values to customize. Copy to devclaw/projects/<project>/workflow.yaml for project-specific overrides.

roles:
  developer:
    models:
      junior: anthropic/claude-haiku-4-5
      medior: anthropic/claude-sonnet-4-5
      senior: anthropic/claude-opus-4-6
  tester:
    models:
      junior: anthropic/claude-haiku-4-5
      medior: anthropic/claude-sonnet-4-5
      senior: anthropic/claude-opus-4-6
  architect:
    models:
      junior: anthropic/claude-sonnet-4-5
      senior: anthropic/claude-opus-4-6
  # Disable a role entirely:
  # architect: false

workflow:
  initial: planning
  states:
    planning:
      type: hold
      label: Planning
      color: "#95a5a6"
      on:
        APPROVE: todo
    todo:
      type: queue
      role: developer
      label: To Do
      color: "#428bca"
      priority: 1
      on:
        PICKUP: doing
    doing:
      type: active
      role: developer
      label: Doing
      color: "#f0ad4e"
      on:
        COMPLETE:
          target: toTest
          actions: [gitPull, detectPr]
        BLOCKED: refining
    toTest:
      type: queue
      role: tester
      label: To Test
      color: "#5bc0de"
      priority: 2
      on:
        PICKUP: testing
    testing:
      type: active
      role: tester
      label: Testing
      color: "#9b59b6"
      on:
        PASS:
          target: done
          actions: [closeIssue]
        FAIL:
          target: toImprove
          actions: [reopenIssue]
        REFINE: refining
        BLOCKED: refining
    toImprove:
      type: queue
      role: developer
      label: To Improve
      color: "#d9534f"
      priority: 3
      on:
        PICKUP: doing
    refining:
      type: hold
      label: Refining
      color: "#f39c12"
      on:
        APPROVE: todo
    done:
      type: terminal
      label: Done
      color: "#5cb85c"
    toDesign:
      type: queue
      role: architect
      label: To Design
      color: "#0075ca"
      priority: 1
      on:
        PICKUP: designing
    designing:
      type: active
      role: architect
      label: Designing
      color: "#d4c5f9"
      on:
        COMPLETE: planning
        BLOCKED: refining
`;
