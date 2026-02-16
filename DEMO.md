# DevClaw Demo — A Live Walkthrough

This demo shows DevClaw in action — from project setup through a complete dev→QA→merge cycle in real time.

## Setup (One-time)

You've installed the plugin and you're in a project Telegram group with your orchestrator agent:

```
You: "Hey, can you help me set up DevClaw for my project?"

Agent: "Sure! Let me walk you through it. What's your project name?"

You: "devclaw"

Agent: "Got it. What's the git repo path?"

You: "~/git/devclaw"

Agent: "Which branch should DEV and QA work against?"

You: "main"

Agent: ✅ DevClaw initialized for 'devclaw'
  - Repo: ~/git/devclaw
  - Base branch: main
  - Workers: DEVELOPER (junior/medior/senior), TESTER
  - Status: Ready to accept issues
```

Then you check the queue:

```
You: "show status"

Agent:
  ⏳ QUEUE (devclaw)
  - Planning: 0 | To Do: 0 | In Review: 0 | To Test: 0
  - Doing: 0 | Testing: 0 | Done: 0
  - Active workers: 0
```

---

## Your First Task

You create an issue and request a developer:

```
You: "Create an issue: Add dark mode toggle. Pick it up for DEV (junior)."

Agent: ✅ Created #42: Add dark mode toggle (Planning)
       🔗 https://github.com/your-org/devclaw/issues/42

       ⚡ Sending DEV (junior) for #42: Add dark mode toggle

       📝 Task message sent to developer session:
       ---
       Issue: #42 — Add dark mode toggle
       Project: devclaw
       Branch: feature/42-add-dark-mode-toggle
       Base branch: main
       
       ## MANDATORY: Task Completion
       When you finish this task, you MUST call `work_finish` with:
       - role: "developer"
       - result: "done" or "review"
       - projectGroupId: "-5176490302"
       - summary: brief description
       
       [Dev role instructions appended...]
       ---

       (Developer worker session created and task dispatched)
```

You can now monitor the task in the queue:

```
You: "show status"

Agent:
  ⏳ QUEUE (devclaw)
  - Planning: 0 | To Do: 0 | In Review: 0 | To Test: 0
  - Doing: 1 | Testing: 0 | Done: 0
  - Active workers: 1 DEVELOPER (junior)
    - #42 (feature/42-add-dark-mode-toggle) — 2m ago
```

---

## Dev Completes Their Work

After a few minutes, the developer finishes:

```
[Developer session]
Developer: "I've implemented the dark mode toggle and pushed the branch.
            Opening a PR for review."

[Developer calls work_finish internally]
work_finish({
  role: "developer",
  result: "review",
  projectGroupId: "-5176490302",
  summary: "Added dark mode toggle to settings page with localStorage persistence"
})

[Agent receives callback]

You: (your Telegram group)

Agent: ✅ DEV DONE #42 (review)
       Summary: Added dark mode toggle to settings page with localStorage persistence
       PR: https://github.com/your-org/devclaw/pull/1234
       
       (Monitoring PR for approval...)
```

You can check the PR, add comments, request changes, or approve:

```
[On GitHub]
You: approve the PR

[Heartbeat polls PR status]

Agent: (after ~60 seconds)
       ✅ PR APPROVED #42
       ⬆️ Merged to main
       🔍 Sending TESTER for #42: Add dark mode toggle
```

---

## QA Tests the Feature

```
You: (your Telegram group)

Agent: 📋 QA task sent to tester session:
       ---
       Issue: #42 — Add dark mode toggle
       Branch: main (test here)
       
       ## Task
       Test the dark mode feature on the deployed version.
       
       When you finish, call work_finish({
         role: "tester",
         result: "pass" | "fail" | "refine" | "blocked"
       })
       ---
```

The tester tests the feature and either passes or fails. Let's say they test thoroughly and pass:

```
[Tester session]

Tester: "✅ Dark mode toggle works correctly:
         - Persists across page reloads
         - Toggles all UI elements
         - Respects prefers-color-scheme on first load
         
         All tests pass."

[Tester calls work_finish]
work_finish({
  role: "tester",
  result: "pass",
  projectGroupId: "-5176490302",
  summary: "Dark mode toggle passes all acceptance criteria."
})

[Agent receives callback]

Agent: 🎉 QA PASS #42
       Summary: Dark mode toggle passes all acceptance criteria.
       Issue closed ✓
```

---

## If QA Finds a Bug

What if the tester finds an issue? No problem — DevClaw re-opens the loop:

```
[Tester session]

Tester: "❌ QA FAIL #42
         Issue: Dark mode toggle doesn't work in Safari.
         Steps: Open in Safari, click toggle, stays light mode."

[Tester calls work_finish]
work_finish({
  role: "tester",
  result: "fail",
  projectGroupId: "-5176490302",
  summary: "Dark mode toggle doesn't work in Safari"
})

[Agent receives callback]

Agent: ❌ QA FAIL #42
       Summary: Dark mode toggle doesn't work in Safari
       Moved to "To Improve"
       
       ⚡ Sending DEV (junior) for #42: Add dark mode toggle
       (Re-dispatching for bug fix)
```

The developer gets the task back, fixes the Safari bug, pushes, and the cycle repeats.

---

## Multi-Project Parallel Execution

You have two projects in two groups. Both can run simultaneously:

```
── Group: "Dev - Frontend" ──────────────────────────────

Agent: ⚡ Sending DEV (medior) for #42: Add dark mode
Agent: 📋 Sending TESTER for #41: Fix button alignment
Agent: ✅ DEV DONE #42 → QA

── Group: "Dev - API" ───────────────────────────────────

Agent: ⚡ Sending DEV (senior) for #18: Implement OAuth2
Agent: ✅ DEV DONE #17 → Merged
Agent: 🎉 QA PASS #16. Closed.
```

Each project has its own queue, workers, and state. The orchestrator (you) stays free to add issues, review code, and make decisions.

---

## Key Commands

Once set up, you use DevClaw through natural language and task creation:

```
You: "Create an issue: Fix login timeout"
Agent: ✅ Created #99
       (Waiting for human approval before entering queue)

You: "Pick up #99 for DEV (medior)"
Agent: ⚡ Sending DEV (medior) for #99

You: "Show status"
Agent: (displays queue, active workers, task timelines)

You: "Check health"
Agent: (scans for zombie workers, orphaned state, stale sessions)
```

---

## What Happens Behind the Scenes

1. **Issue created** → labeled "Planning" → waits for your approval
2. **You pick up for DEV** → label → "To Do" → worker dispatched → label → "Doing"
3. **DEV opens PR** → label → "In Review" → heartbeat polls PR status
4. **PR approved** → auto-merged → label → "To Test" → tester dispatched
5. **TESTER tests** → label → "Testing"
6. **TESTER passes** → label → "Done" → issue closed
7. **TESTER fails** → label → "To Improve" → developer re-dispatched
8. **DEV fixes** → cycle repeats from step 3

---

## Next Steps

- **Read more:** [CONFIGURATION.md](docs/CONFIGURATION.md) for custom prompts, labels, and workflows
- **Troubleshoot:** [MANAGEMENT.md](docs/MANAGEMENT.md) for health checks and zombie worker recovery
- **Deep dive:** [ARCHITECTURE.md](docs/ARCHITECTURE.md) to understand how DevClaw works under the hood
