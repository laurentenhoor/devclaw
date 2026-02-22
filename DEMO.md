# DevClaw Demo: Getting Started

Welcome! This guide walks you through **how DevClaw works** and **what you can do with it** — using practical examples.

## What is DevClaw?

DevClaw turns your AI agent (in OpenClaw) into a development team manager. You describe work, and DevClaw:

- **Creates issues** in GitHub/GitLab
- **Assigns tasks** to AI developers, testers, and architects
- **Runs the development pipeline** — dev → code review → merge
- **Handles feedback loops** — if a reviewer asks for changes, dev automatically picks it back up
- **Tracks everything** — audit logs, issue state, PR status

All of this happens **automatically and autonomously** across multiple projects.

---

## The Team

DevClaw hires AI workers in **4 roles**, each with **3 skill levels**:

### Developer
Writes code, commits to branches, opens PRs.
- **Junior** — typos, simple bugs, small features
- **Medior** — standard features, integration work
- **Senior** — complex logic, architecture, large refactors

### Tester / Reviewer
Reviews PRs, checks for bugs, approves or requests changes.
- **Junior** — automated checks, basic sanity tests
- **Medior** — functional testing, edge cases
- **Senior** — security, performance, architecture review

### Architect
Researches design problems, proposes solutions, creates implementation tasks.
- **Junior** — standard design decisions
- **Senior** — complex architecture, trade-off analysis

---

## The Workflow

Every issue follows this path:

```
┌─────────┐    ┌────────┐    ┌───────┐    ┌──────────┐    ┌──────┐
│Planning │──→ │ To Do  │──→ │ Doing │──→ │ To Review│──→ │ Done │
└─────────┘    └────────┘    └───────┘    └──────────┘    └──────┘
      ↑                                          ↓
      └──────────────────────────────────────────┘
            (DEV picks it back up if
             changes are requested)
```

**Step by step:**

1. **Planning** — Issue created, human decides if it's ready
2. **To Do** — Issue approved, waiting in queue for a developer
3. **Doing** — A developer is working on it
4. **To Review** — Developer opened a PR, waiting for code review
5. **Done** — PR approved, auto-merged, issue closed

---

## A Real Example: Adding a Login Button

Let's say you want to add a login button to your app. Here's what happens:

### Step 1: You create an issue

You (in your chat):
```
"Create an issue: Add login button to navbar.
Description: Add a clickable button that links to /login. 
Should be visible on all pages. Use brand colors from design.css."
```

DevClaw creates issue #42 on GitHub and puts it in **Planning** state.

### Step 2: You approve it

You:
```
"Move #42 to To Do"
```

The issue is now in the queue waiting for a developer.

### Step 3: Scheduler picks a developer

The DevClaw scheduler (running continuously) sees a task in the queue and dispatches a **junior developer**:

```
⚡ Sending DEV (junior) for #42: Add login button to navbar
```

The developer:
- Creates a git worktree (isolated working branch)
- Reads the issue details and comments
- Implements the change
- Writes a test
- Opens a PR (without closing keywords — DevClaw manages that)

### Step 4: Developer says "Done"

The developer calls `work_finish`:

```
"✅ DEV DONE #42 — Added login button to navbar.
PR: https://github.com/yourrepo/pull/123"
```

DevClaw automatically:
- Moves the issue to **To Review** (PR pending)
- Notifies the team
- Waits for PR approval

### Step 5: Code review

A reviewer checks the PR on GitHub. They:
- See the changes are good → Click "Approve" on GitHub

DevClaw sees the approval and:
- Auto-merges the PR
- Closes issue #42
- Moves it to **Done**

```
🔀 PR approved for #42 — auto-merged. Issue closed.
```

**Total time:** A few minutes. All automated. You can focus on strategy instead of logistics.

---

## When Things Get Tricky

### Reviewer asks for changes

If the reviewer requests changes instead of approving:

```
💬 PR changes requested for #42 — back to DEV
```

DevClaw:
- Moves issue to **To Improve**
- Waits for the developer to pick it back up
- Automatically re-assigns the same developer (or picks a new one)
- Developer fixes the feedback and re-opens the PR
- Reviewer approves the next round

### Developer gets stuck

If the developer runs into a blocker they can't solve:

```
❌ DEV BLOCKED #42 — needs database migration
```

DevClaw:
- Moves issue to **Refining**
- Notifies you (the orchestrator) that something's stuck
- Waits for you to resolve the blocker manually

You might then:
- Create a separate task for the database migration
- Or add a comment with guidance
- Then move the issue back to **To Do** when ready

### Complex features need architecture first

For large changes, you might want a senior architect to research the design first:

```
"Move #50 to To Research"
```

DevClaw dispatches a **senior architect** who:
- Researches options and trade-offs
- Posts findings as comments
- Creates follow-up implementation tasks
- Closes the research issue when done

[Read more in [DEMO2.md](DEMO2.md)]

---

## Key Concepts

### 1. Issues are the source of truth

All work lives in GitHub/GitLab issues. DevClaw reads from them, updates them, and links to PRs. Your issue tracker is the single source of truth — not an internal database.

### 2. Sessions accumulate context

When a developer picks up a task, they get a **session** with:
- Full repo context (diffs, test results, existing code)
- Issue history and comments
- Task-specific instructions

On the next task, they reuse that session and context. This saves ~40-60% tokens per task compared to cold starts.

### 3. Automatic tier selection

DevClaw picks the right skill level for the task:
- Simple bug fixes → Junior developer (cheaper, faster)
- Standard features → Medior developer
- Complex architecture → Senior developer or architect

You can override if you want a specific level.

### 4. The scheduler runs continuously

DevClaw includes a **heartbeat** service that:
- Scans queues every few seconds
- Dispatches workers when tasks are ready
- Detects stalled workers and recovers
- Runs 24/7, even when you're asleep

All without burning tokens on the orchestrator — pure CLI logic.

---

## Common Commands

Here are the main things you can do in chat:

### Create and assign work

```
"Create an issue: Add dark mode toggle to settings.
Description: Let users switch between light and dark themes.
Store preference in localStorage."

"Create an issue and pick it up with a junior dev: Fix typo in /about"
```

### Move issues through the workflow

```
"Move #42 to To Do"        # Approve and queue
"Move #43 to To Research"  # Research before dev
"Move #44 to Refining"     # Manual fix needed
```

### Add detail without blocking

```
"Add a comment to #42: Consider adding a dark mode option too"
```

### Check status

```
"Show me the status of all projects"
"List all issues in To Do"
"What's currently being worked on?"
```

### Create research tasks

For architectural decisions:

```
"Research: Should we use PostgreSQL or MongoDB for sessions?
Constraints: must support 10k concurrent connections, 
existing SQLite for users table, no additional cloud costs."
```

DevClaw dispatches a senior architect to investigate and propose.

---

## Model Selection

DevClaw uses **3 model tiers** to balance speed and capability:

| Tier | Use Case | Default Model | Speed | Cost |
|------|----------|---------------|-------|------|
| **Junior** | Simple bugs, typos | Claude Haiku | ⚡ Very Fast | $ |
| **Medior** | Standard features | Claude Sonnet | ⚡ Fast | $$ |
| **Senior** | Complex logic, architecture | Claude Opus | 🐌 Slower | $$$ |

You pick the model at setup time. DevClaw chooses the tier based on issue complexity. You can override if needed:

```
"Move #99 to To Do (force: senior)"  # Use Opus even for "simple" tasks
```

---

## Workspace Files

After setup, DevClaw creates these files in your workspace:

| File | Purpose |
|------|---------|
| `AGENTS.md` | Worker instructions (how devs/testers/architects behave) |
| `HEARTBEAT.md` | How the scheduler works |
| `TOOLS.md` | Reference for available tools |
| `devclaw/projects.json` | Registered projects and their settings |
| `devclaw/workflow.yaml` | State machine, review policy, timeouts |
| `devclaw/prompts/<role>.md` | Custom instructions per role |

You can edit these to tune DevClaw's behavior. [Learn more in the configuration guide](docs/CONFIGURATION.md).

---

## First Steps

1. **Install DevClaw**
   ```bash
   openclaw plugins install @laurentenhoor/devclaw
   ```

2. **Run setup**
   ```bash
   # Conversational setup (recommended)
   "Hey, can you help me set up DevClaw?"
   
   # Or direct CLI
   openclaw devclaw setup
   ```

3. **Register a project**
   ```
   "Register my project: my-webapp
   Repo: ~/git/my-webapp
   Base branch: main"
   ```

4. **Create your first task**
   ```
   "Create an issue: Add a README section on DevClaw"
   ```

5. **Watch it work**
   ```
   "Move #1 to To Do"
   ```
   DevClaw will dispatch a dev, and you'll see the full pipeline in action.

---

## Next Steps

- **[Onboarding Guide](docs/ONBOARDING.md)** — Step-by-step setup walkthrough
- **[Workflow Reference](docs/WORKFLOW.md)** — Detailed state machine and configuration
- **[Tools Reference](docs/TOOLS.md)** — All available commands and their parameters
- **[Advanced Scenarios](DEMO2.md)** — Multi-role workflows, architecture research, feedback loops
- **[Configuration Guide](docs/CONFIGURATION.md)** — Customize review policy, timeouts, and model selection
- **[Management Guide](docs/MANAGEMENT.md)** — Running multiple projects, monitoring workers, audit logs

---

## Questions?

Common issues and how to fix them:

**"The plugin didn't install"**
- Check: `openclaw plugins list`
- Try: `openclaw gateway restart` (wait 3 seconds)
- Check logs: `openclaw logs`

**"Dev picks up the task but doesn't do anything"**
- Check: `openclaw logs` for errors
- Verify: `gh auth status` (GitHub CLI must be authenticated)
- Verify: The repo has issues enabled on GitHub

**"Issue stays in Planning forever"**
- You need to move it to `To Do` manually first
- Or create with `label: "To Do"` to skip Planning

**"PR doesn't auto-merge"**
- Verify: Branch protection rules allow auto-merge on your repo
- Verify: PR is on the base branch (usually `main`)
- Check: `devclaw/workflow.yaml` — `reviewPolicy` should allow auto-merge

**More help:**
- [Onboarding troubleshooting](docs/ONBOARDING.md#troubleshooting)
- [Workflow FAQ](docs/WORKFLOW.md#faq)
- Open an issue on [GitHub](https://github.com/laurentenhoor/devclaw/issues)

---

**Happy shipping! 🚀**
