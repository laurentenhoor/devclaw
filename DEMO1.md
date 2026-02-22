# DevClaw Demo - Getting Started

Welcome to **DevClaw**! This demo will walk you through setting up and using DevClaw to manage your development workflow across multiple roles and projects.

## What is DevClaw?

DevClaw is an intelligent development workflow orchestrator that manages tasks across your team:

- **Developers** implement features and fixes
- **Testers** verify quality and run tests
- **Architects** research design decisions and create implementation tasks
- **Reviewers** approve and merge code

All workers are AI-powered agents that coordinate through your project's issue tracker and Git workflow.

## Quick Start: Create Your First Project

### 1. Register Your Project

```bash
openclaw setup
```

This interactive setup guides you through:
- Project name and repository path
- Base branch (typically `main` or `develop`)
- Deployment configuration
- Channel binding (Telegram, WhatsApp)

### 2. Initialize DevClaw in Your Repo

The setup creates:
- `devclaw/projects.json` — project registry
- `devclaw/prompts/` — role-specific instructions
- `AGENTS.md` — worker behavior guides
- `HEARTBEAT.md` — monitoring and health checks

### 3. Create Your First Issue

```bash
# From a group chat channel linked to your project
/create-task "Fix: Login timeout after 5 minutes"
```

Or use the CLI:
```bash
task_create({
  projectSlug: "my-webapp",
  title: "Fix: Login timeout after 5 minutes",
  description: "Users are being logged out too quickly. Increase session timeout to 30 minutes.",
  label: "To Do"  // Ready for developers to pick up
})
```

## Workflow States

DevClaw organizes work through these states:

| State | What Happens |
|-------|--------------|
| **Planning** | Issue awaits approval before entering the queue |
| **To Do** | Ready for a developer to pick up |
| **Doing** | Developer is actively working |
| **To Review** | PR created, waiting for reviewer |
| **Reviewing** | Reviewer is examining the changes |
| **Done** | Issue complete and merged |
| **To Research** | Architect researching a design problem |
| **Researching** | Architect actively investigating |
| **Refining** | Tester found issues, developer refining |
| **To Improve** | Post-merge improvements identified |

## Example: End-to-End Workflow

### Step 1: Developer Picks Up a Task

```
Issue #42: "Add user profile page"
Status: To Do → Doing
```

Developer calls:
```bash
work_start({ projectSlug: "my-webapp" })
```

The system:
1. Creates a Git worktree (`feature/42-user-profile`)
2. Assigns the task to the developer
3. Transitions the issue to "Doing"

### Step 2: Developer Implements & Creates PR

```bash
git add .
git commit -m "feat: add user profile page (#42)"
git push
# Create PR on GitHub/GitLab
```

Developer marks task complete:
```bash
work_finish({
  role: "developer",
  result: "done",
  projectSlug: "my-webapp",
  summary: "User profile page with settings and avatar upload"
})
```

Issue transitions: **Doing → To Review** (awaiting review)

### Step 3: Reviewer Approves or Rejects

Reviewer examines the PR and calls:

**If approved:**
```bash
work_finish({
  role: "reviewer",
  result: "approve",
  projectSlug: "my-webapp"
})
```
→ Issue transitions: **Reviewing → Done** (auto-merged)

**If changes needed:**
```bash
work_finish({
  role: "reviewer",
  result: "reject",
  projectSlug: "my-webapp",
  summary: "Please add error handling for failed uploads"
})
```
→ Issue transitions: **Reviewing → Doing** (back to developer)

### Step 4: Testing (Optional)

If testing is enabled in your workflow:

```bash
work_start({ projectSlug: "my-webapp", role: "tester" })
```

Tester runs tests and calls:

```bash
work_finish({
  role: "tester",
  result: "pass",  // or "fail", "refine"
  projectSlug: "my-webapp"
})
```

## Architecture: Design Research

For complex decisions, dispatch an **Architect**:

```bash
research_task({
  projectSlug: "my-webapp",
  title: "Research: Session persistence strategy",
  description: "Sessions are lost on restart. Current impl uses in-memory Map. Need SQLite-backed solution with <50ms latency.",
  focusAreas: ["SQLite vs file-based", "migration path", "cache invalidation"],
  complexity: "complex"
})
```

The Architect will:
1. Research the problem systematically
2. Post findings as comments on the issue
3. Create implementation tasks
4. Transition the issue to "Done" with recommendations

## Monitoring: Check Project Health

```bash
tasks_status({ projectSlug: "my-webapp" })
```

Shows:
- **Hold** — Issues awaiting human input
- **Active** — Issues being worked on
- **Queue** — Issues queued for work

Check worker health:
```bash
health({ projectSlug: "my-webapp" })
```

Detects stale workers and orphaned issues.

## Multi-Project Orchestration

DevClaw can manage multiple projects in parallel:

```bash
task_list({ projectSlug: "my-webapp", stateType: "active" })
task_list({ projectSlug: "backend-api", stateType: "queue" })
```

Each project has its own:
- Repository and branch
- Workflow configuration
- Role prompts and model assignments
- Channel notification

## Configuration: Customize Your Workflow

Edit `devclaw/workflow.yaml` to:

- Change review policy (all PRs, selected developers, etc.)
- Enable/disable testing phase
- Adjust role prompts per project
- Override model assignments

```bash
workflow_guide()  # Full reference
```

## Tips & Best Practices

✅ **Always use dedicated worktrees** — keeps the repo clean, prevents conflicts  
✅ **Write clear issue descriptions** — agents understand context better  
✅ **Use conventional commits** — `feat:`, `fix:`, `refactor:`, etc.  
✅ **Avoid auto-closing keywords** — DevClaw manages issue state  
✅ **Review agent comments** — they often catch edge cases  

❌ **Don't merge PRs manually** — let the system auto-merge after approval  
❌ **Don't work in the root worktree** — always create feature branches  
❌ **Don't edit closed issues** — planning issues only (before "To Do")

## Troubleshooting

**Worker stuck in "Doing"?**
```bash
health({ projectSlug: "my-webapp", fix: true })
```

**Issue in wrong state?**
```bash
task_update({
  projectSlug: "my-webapp",
  issueId: 42,
  state: "To Do"
})
```

**Need to escalate to senior?**
```bash
task_update({
  projectSlug: "my-webapp",
  issueId: 42,
  level: "senior",
  reason: "Complex refactor needs expertise"
})
```

## Next Steps

1. **Run the onboarding:** `openclaw onboard` or `setup`
2. **Register your first project:** `project_register`
3. **Create a test issue** in your project chat
4. **Watch the agents work** — check comments and PRs
5. **Review and approve** — transition issues to done

---

For more details, see:
- **AGENTS.md** — worker instructions
- **HEARTBEAT.md** — health monitoring
- **IDENTITY.md** — system prompts
- **TOOLS.md** — available tools reference
- **devclaw/projects.json** — project registry
