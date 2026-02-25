# Research Workflow Patterns

How to approach research, design, and investigation tasks in DevClaw. Six modes, ordered from most hands-on to most automated.

---

## 1. Hands-On

**You + AI + terminal. No DevClaw involved.**

Open Claude Code or Codex in the project directory and research interactively. You drive the conversation, read code together, explore options, and make decisions in real time.

**Flow:**
```
You ←→ Claude Code (local terminal)
```

**When to use:**
- Quick "how does this work?" explorations
- You want to stay in the loop on every step
- Spiking / prototyping before committing to an approach
- The research is tightly coupled with your own thinking

**Tradeoffs:**
- Fastest feedback loop — zero overhead
- No audit trail, no issue tracking, no handoff to workers
- Results live in your terminal history only
- You do all the work yourself

---

## 2. Focused Chat

**Research conversation in a clean chat, then dispatch a worker.**

Start a secondary chat session with the orchestrator (separate from the main notification channel). Discuss the problem, explore the codebase together, form a plan. When ready, the orchestrator creates an issue and dispatches a developer via `task_start`.

**Flow:**
```
You ←→ Orchestrator (secondary chat)
         │
         ├── discuss, plan, explore codebase
         │
         └── task_create → task_start → Developer worker → PR
```

**When to use:**
- You want to think through the problem with the AI before committing
- The research phase needs back-and-forth discussion
- You want a clean conversation without heartbeat noise
- You'll hand off implementation once the approach is clear

**Tradeoffs:**
- Clean separation: research conversation vs notifications
- You stay in control of the "what" — worker handles the "how"
- Requires managing a second chat window
- Research discussion isn't captured on the issue (unless you summarize)

---

## 3. Inline Chat

**Same as above, but in the main chat where notifications also appear.**

Research and plan in the primary orchestrator chat. Heartbeat notifications (PR merged, worker complete, etc.) interleave with your conversation. When ready, dispatch a developer.

**Flow:**
```
You ←→ Orchestrator (primary chat, mixed with notifications)
         │
         ├── discuss, plan (interleaved with heartbeat updates)
         │
         └── task_create → task_start → Developer worker → PR
```

**When to use:**
- You're already in the main chat and want to stay there
- The research is quick — not a deep multi-hour exploration
- You want to stay aware of other project activity while researching

**Tradeoffs:**
- No context switching — everything in one place
- Notifications can break your train of thought
- Conversation gets noisy on active projects
- Same audit trail gap as mode 2 (discussion not on the issue)

---

## 4. Architect

**Delegate research to an architect worker. Review findings. Approve implementation tasks.**

Use `research_task` to spawn an architect. The architect explores the codebase, investigates alternatives, posts findings as issue comments, and creates implementation tasks in Planning. You review the findings and approve tasks to move them to To Do.

**Flow:**
```
You → Orchestrator → research_task → creates "To Research" issue
                                          │
                                    Architect worker
                                          │
                                    ├── researches codebase, docs, web
                                    ├── posts findings (task_comment)
                                    ├── creates implementation tasks (task_create → Planning)
                                    └── work_finish(done) → research issue closed
                                          │
                                    You review Planning tasks
                                          │
                                    Approve → To Do → Developer worker → PR → Human review
```

**When to use:**
- Design decisions that need structured investigation (3+ alternatives)
- You want documented findings on the issue for the team
- The research should produce actionable tasks, not just a conversation
- You want to review the plan before any code is written

**Tradeoffs:**
- Best audit trail — findings + tasks all on GitHub/GitLab issues
- Architect does the heavy lifting; you review output
- Human gate at two points: approve Planning tasks + review PRs
- Slower turnaround — async by nature
- If architect gets stuck: goes to Refining, needs your input

---

## 5. Senior Spike

**Skip the separate research phase. A senior developer researches as part of implementation.**

Create the issue with enough context for a senior developer to both figure out the approach AND implement it. The senior dev reads the codebase, makes design decisions, implements, and opens a PR. You review the PR to validate both the approach and the code.

**Flow:**
```
You → Orchestrator → task_create + task_start(level: "senior")
                          │
                    Senior Developer worker
                          │
                    ├── researches codebase (as part of implementation)
                    ├── makes design decisions
                    ├── implements solution
                    └── opens PR
                          │
                    You review PR (approach + code)
                          │
                    Approve → heartbeat auto-merges → Done
```

**When to use:**
- The problem is well-scoped but the implementation path isn't obvious
- You trust a senior-level model to make reasonable design choices
- You want to review the actual code, not a written analysis
- Speed matters more than documented alternatives

**Tradeoffs:**
- Fastest path from "I have a problem" to "here's a PR"
- Design decisions are implicit in the code, not documented separately
- You validate the approach by reading the PR, not a research document
- No Planning gate — code is written before you see the approach
- If the approach is wrong, the PR gets rejected and work is wasted
- Human review catches bad decisions but only after implementation

---

## 6. Autopilot

**Maximum automation. Senior dev researches, implements, and the system merges.**

Same as mode 5, but with `reviewPolicy: agent` or `reviewPolicy: auto`. The PR is reviewed by an agent reviewer (or auto-merged for senior work under `auto` policy). No human in the loop unless something fails.

**Flow:**
```
You → Orchestrator → task_create + task_start(level: "senior")
                          │
                    Senior Developer worker
                          │
                    ├── researches + implements + opens PR
                    └── work_finish(done) → To Review
                          │
                    Agent reviewer (or auto-merge)
                          │
                    ├── approve → auto-merge → Done
                    └── reject → To Improve → Developer fixes → retry
```

**When to use:**
- High confidence in the task scope and constraints
- Low-risk changes where a bad merge is easily reverted
- You want hands-off operation (fire and forget)
- Batch processing many similar research+implement tasks

**Tradeoffs:**
- Fully autonomous — no human blocks the pipeline
- Fastest end-to-end throughput
- No human validates the design decisions OR the code
- Risk: wrong approach gets merged without review
- Best paired with good test coverage as a safety net
- Agent reviewer catches code issues but not design misalignment

---

## Choosing a Mode

| Factor | Hands-On | Focused Chat | Inline Chat | Architect | Senior Spike | Autopilot |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **Human involvement** | Full | High | High | Medium | Low | None |
| **Audit trail** | None | Chat only | Chat only | Full (issues) | PR only | PR only |
| **Design documentation** | None | Chat | Chat | Issue comments | Implicit in PR | Implicit in PR |
| **Speed** | Instant | Fast | Fast | Slow | Medium | Fast |
| **Risk of wrong approach** | Low (you decide) | Low | Low | Low | Medium | High |
| **Scales to team** | No | No | No | Yes | Yes | Yes |
| **Cost (tokens)** | Your session | Orchestrator + dev | Orchestrator + dev | Architect + dev(s) | Senior dev | Senior dev + reviewer |

### Interaction & Feedback

| Factor | Hands-On | Focused Chat | Inline Chat | Architect | Senior Spike | Autopilot |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **Feedback loop** | Real-time | Real-time | Real-time | Async (issue comments) | Async (PR review) | Async (PR review) |
| **How you redirect** | Just talk | Just talk | Just talk | Comment on issue | Request changes on PR | Agent auto-retries |
| **Course correction cost** | Free | Free | Free | Low (re-queue) | High (rework PR) | High (rework PR) |
| **When you see output** | Immediately | Immediately | Immediately | After research completes | After PR opens | After merge |
| **Visibility during work** | Full (you're there) | Full (you're there) | Partial (noise) | None until done | None until PR | None until merge |
| **Iteration style** | Conversational | Conversational | Conversational | Review + approve/refine | Review + approve/reject | Retry on failure |
| **Context preserved across iterations** | Yes (same session) | Yes (same session) | Partially (interleaved) | Yes (issue thread) | No (new dispatch) | No (new dispatch) |
| **Can interrupt mid-work** | Yes | Yes | Yes | No (async worker) | No (async worker) | No (async worker) |
| **Collaboration feel** | Pair programming | Pair planning | Pair planning | Delegated research | Delegated execution | Fire and forget |

**Rules of thumb:**
- **Exploring / learning** → Hands-On
- **Needs discussion first** → Focused Chat or Inline Chat
- **Needs documented alternatives** → Architect
- **Well-scoped, just needs a smart dev** → Senior Spike
- **Well-scoped, low risk, high trust** → Autopilot

---

## Architect vs Senior Spike

The two delegated modes that handle research differently. This is the key decision when you have a non-trivial problem and want to hand it off.

### What happens to the research

| | Architect | Senior Spike |
|---|---|---|
| **Research output** | Structured findings posted as issue comments — problem statement, alternatives, pros/cons, recommendation | No separate research output — design decisions are embedded in the code |
| **Where decisions live** | On the research issue, readable by anyone | In the PR diff, only visible if you read the code |
| **Reusable knowledge** | Yes — the issue becomes documentation | No — if the PR is rejected, the reasoning is lost |

### What happens after the research

| | Architect | Senior Spike |
|---|---|---|
| **What it produces** | Implementation tasks (issues) | A PR with working code |
| **Breakdown** | Can create multiple tasks for different parts | Single PR, single task |
| **First human checkpoint** | After research, before any code | After code is written |
| **Wrong approach cost** | Cheap — only research tokens wasted, no code written | Expensive — full implementation wasted |
| **Right approach speed** | Slower — research done, then dev still needs to implement | Faster — research + implementation in one pass |

### The approval gate

The Architect creates tasks in **Planning** by default. This gives you two options:

**Planning → human reviews → To Do** (current default)
- You see each task before work starts
- You can comment, refine, split, or reject tasks
- Adds a manual step between research and implementation

**Planning → comment to iterate → To Do** (requires planning pass — not yet implemented)
- Same as above, but you can comment on a Planning item and the system re-dispatches the architect to refine it
- The architect sees your comment in context, updates the task, and it stays in Planning for another round
- Enables async back-and-forth without manual state transitions

**Straight to To Do** (skip the gate)
- Architect creates tasks directly in To Do
- Heartbeat picks them up immediately — no human approval needed
- Fastest pipeline: research → tasks → dev → PR
- You trust the architect's breakdown — your only checkpoint is PR review
- Good for well-understood domains where the breakdown is mechanical

### When to use which

| Scenario | Architect | Senior Spike |
|---|---|---|
| Multiple possible approaches, unclear tradeoffs | Yes | No |
| Need to break into 3+ implementation tasks | Yes | No |
| Team needs to understand *why* this approach | Yes | No |
| Well-scoped, one clear implementation path | Overkill | Yes |
| Speed matters more than documentation | No | Yes |
| Wrong approach has high cost (data migration, API contract) | Yes (catch it before code) | Risky |
| Wrong approach has low cost (easily reverted) | Overkill | Yes |
