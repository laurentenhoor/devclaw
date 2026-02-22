# DevClaw Demo — Get Started in 5 Minutes

Welcome to **DevClaw**, the development plugin for [OpenClaw](https://openclaw.ai) that turns your group chats into autonomous dev teams.

## What is DevClaw?

DevClaw orchestrates a multi-project development pipeline. You create GitHub/GitLab issues, and an agent automatically:
- Assigns tasks to developer, tester, reviewer, and architect agents
- Manages workflow state (Planning → To Do → Doing → Review → Done)
- Routes work between roles based on issue comments and test results
- Keeps everything audited and visible in your group chat

No dashboards, no databases — just GitHub/GitLab issues and OpenClaw agents.

## Key Concepts

### Orchestrator
The agent managing your group chat. It watches for issues, dispatches workers, and keeps the pipeline moving.

### Workers
Specialized agents that perform actual work:
- **Developers** write code and open PRs
- **Testers** run tests and verify fixes
- **Reviewers** approve/reject PRs with feedback
- **Architects** research design problems and propose solutions

Each worker has a skill tier: **junior** (quick tasks), **mid** (standard features), or **senior** (complex/critical work).

### Workflow States
Issues flow through a pipeline:
1. **Planning** — New issue, waiting for approval
2. **To Do** — Approved, ready for development
3. **Doing** — Developer is working on it
4. **To Review** — PR opened, awaiting review
5. **Reviewing** — Reviewer examining the code
6. **Done** — Merged and closed

Feedback loops: if a reviewer requests changes, the issue goes back to **Doing** for the developer to refine.

### Sessions
Each worker spawns a persistent session that accumulates codebase knowledge across multiple tasks. This reduces token usage and improves consistency.

## Quick Start Example

### 1. Register Your Project

In your project's group chat (Telegram/WhatsApp):

```
"Set up DevClaw for this project"
```

The agent will ask:
- Project name and slug
- Git repository path
- Base branch (e.g., `main`)
- Development branch (optional)

Once confirmed, the agent creates workflow labels in GitHub/GitLab.

### 2. Create an Issue

In the same chat, create a task:

```
"Create an issue: Add dark mode toggle to settings page"
```

The agent:
- Creates the issue on GitHub/GitLab in **Planning** state
- Posts a confirmation in chat with the issue link

### 3. Move to Queue

Once you've reviewed the issue and like it:

```
"Move #42 to To Do"
```

The issue is now in the work queue.

### 4. Dispatch a Worker

The orchestrator's heartbeat automatically picks up the next issue and dispatches a developer:

```
⚡ Sending DEV (junior) for #42: Add dark mode toggle to settings page
```

The developer creates a git worktree, implements the feature, opens a PR, and updates the issue.

### 5. Review & Merge

When the PR is ready, a reviewer approves it:

```
✅ DEV DONE #42 — Dark mode toggle added. PR opened for review.
🔀 PR approved for #42 — auto-merged. Issue closed.
```

### 6. Handle Feedback

If the reviewer requests changes:

```
🔄 PR changes requested for #42 — Back to DEV.
⚡ Sending DEV (junior) for #42: Add dark mode toggle to settings page
```

The developer picks up the refined version and completes it.

## Managing Multiple Projects

Create separate group chats for each project. Each chat gets its own:
- Issue queue and workflow state
- Worker pool (developers, testers, reviewers, architects)
- Session history and audit logs

The orchestrator runs autonomously across all projects.

## Example: A Day in DevClaw

```
── Group: "Dev - My Webapp" ──────────────────────────────

Agent:  "⚡ Sending DEV (medior) for #42: Add login page"
Agent:  "✅ DEV DONE #42 — Login page with OAuth. PR opened for review."
Agent:  "🔀 PR approved for #42 — auto-merged. Issue closed."
Agent:  "⚡ Sending DEV (junior) for #43: Fix button color on /settings"

  You:  "Create an issue: Refactor profile page, pick it up"

Agent:  created #44 "Refactor user profile page" on GitHub — To Do
Agent:  "⚡ Sending DEV (medior) for #44: Refactor user profile page"

Agent:  "✅ DEV DONE #43 — Fixed dark-mode color. PR opened for review."
Agent:  "🔀 PR approved for #43 — auto-merged. Issue closed."
```

While you're away, the system processes your queue. When you drop in to create an issue, it's immediately queued and processed.

## What's Next?

- **Full documentation** → See [AGENTS.md](AGENTS.md)
- **Configuration & setup** → See [docs/ONBOARDING.md](docs/ONBOARDING.md)
- **Workflow states & rules** → See [docs/WORKFLOW.md](docs/WORKFLOW.md)
- **All tools reference** → See [docs/TOOLS.md](docs/TOOLS.md)
- **Architecture** → See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Common Commands

In your group chat:

```
"Create an issue: [your title]"                  # Add a new task
"Move #42 to To Do"                              # Approve and queue
"Assign #42 to @senior"                          # Escalate to senior developer
"What's in the queue?"                           # Show pending tasks
"Show the dashboard"                             # Project status
```

## How Workers Communicate

All work happens in comments on the GitHub/GitLab issue. Developers post implementation notes, reviewers leave feedback, testers report test results. Everything stays in one place.

---

**Questions?** Check [AGENTS.md](AGENTS.md) for developer instructions, or [docs/MANAGEMENT.md](docs/MANAGEMENT.md) for orchestrator commands.

Happy shipping! 🚀
