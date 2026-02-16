# DevClaw — Architecture & Component Interaction

## How it works

One OpenClaw agent process serves multiple group chats — each group gives it a different project context. The orchestrator role, the workers, the task queue, and all state are fully isolated per group.

```mermaid
graph TB
    subgraph "Group Chat A"
        direction TB
        A_O["Orchestrator"]
        A_GL[GitHub/GitLab Issues]
        A_DEV["DEVELOPER (worker session)"]
        A_TST["TESTER (worker session)"]
        A_O -->|work_start| A_GL
        A_O -->|dispatches| A_DEV
        A_O -->|dispatches| A_TST
    end

    subgraph "Group Chat B"
        direction TB
        B_O["Orchestrator"]
        B_GL[GitHub/GitLab Issues]
        B_DEV["DEVELOPER (worker session)"]
        B_TST["TESTER (worker session)"]
        B_O -->|work_start| B_GL
        B_O -->|dispatches| B_DEV
        B_O -->|dispatches| B_TST
    end

    AGENT["Single OpenClaw Agent"]
    AGENT --- A_O
    AGENT --- B_O
```

Worker sessions are expensive to start — each new spawn reads the full codebase (~50K tokens). DevClaw maintains **separate sessions per level per role** ([session-per-level design](#session-per-level-design)). When a medior developer finishes task A and picks up task B on the same project, the accumulated context carries over — no re-reading the repo. The plugin handles all session dispatch internally via OpenClaw CLI; the orchestrator agent never calls `sessions_spawn` or `sessions_send`.

```mermaid
sequenceDiagram
    participant O as Orchestrator
    participant DC as DevClaw Plugin
    participant IT as Issue Tracker
    participant S as Worker Session

    O->>DC: work_start({ issueId: 42, role: "developer" })
    DC->>IT: Fetch issue, verify label
    DC->>DC: Assign level (junior/medior/senior)
    DC->>DC: Check existing session for assigned level
    DC->>IT: Transition label (To Do → Doing)
    DC->>S: Dispatch task via CLI (create or reuse session)
    DC->>DC: Update projects.json, write audit log
    DC-->>O: { success: true, announcement: "..." }
```

## Agents vs Sessions

Understanding the OpenClaw model is key to understanding how DevClaw works:

- **Agent** — A configured entity in `openclaw.json`. Has a workspace, model, identity files (SOUL.md, IDENTITY.md), and tool permissions. Persists across restarts.
- **Session** — A runtime conversation instance. Each session has its own context window and conversation history, stored as a `.jsonl` transcript file.
- **Sub-agent session** — A session created under the orchestrator agent for a specific worker role. NOT a separate agent — it's a child session running under the same agent, with its own isolated context. Format: `agent:<parent>:subagent:<project>-<role>-<level>`.

### Session-per-level design

Each project maintains **separate sessions per developer level per role**. A project's DEVELOPER might have a junior session, a medior session, and a senior session — each accumulating its own codebase context over time.

```
Orchestrator Agent (configured in openclaw.json)
  └─ Main session (long-lived, handles all projects)
       │
       ├─ Project A
       │    ├─ DEVELOPER sessions: { junior: <key>, medior: <key>, senior: null }
       │    ├─ TESTER sessions:    { junior: null, medior: <key>, senior: null }
       │    └─ ARCHITECT sessions: { junior: <key>, senior: null }
       │
       └─ Project B
            ├─ DEVELOPER sessions: { junior: null, medior: <key>, senior: null }
            └─ TESTER sessions:    { junior: null, medior: <key>, senior: null }
```

Why per-level instead of switching models on one session:
- **No model switching overhead** — each session always uses the same model
- **Accumulated context** — a junior session that's done 20 typo fixes knows the project well; a medior session that's done 5 features knows it differently
- **No cross-model confusion** — conversation history stays with the model that generated it
- **Deterministic reuse** — level selection directly maps to a session key, no patching needed

### Plugin-controlled session lifecycle

DevClaw controls the **full** session lifecycle end-to-end. The orchestrator agent never calls `sessions_spawn` or `sessions_send` — the plugin handles session creation and task dispatch internally using the OpenClaw CLI:

```
Plugin dispatch (inside work_start):
  1. Assign level, look up session, decide spawn vs send
  2. New session:  openclaw gateway call sessions.patch → create entry + set model
                   openclaw gateway call agent → dispatch task
  3. Existing:     openclaw gateway call agent → dispatch task to existing session
  4. Return result to orchestrator (announcement text, no session instructions)
```

The agent's only job after `work_start` returns is to post the announcement to Telegram. Everything else — level assignment, session creation, task dispatch, state update, audit logging — is deterministic plugin code.

**Why this matters:** Previously the plugin returned instructions like `{ sessionAction: "spawn", model: "sonnet" }` and the agent had to correctly call `sessions_spawn` with the right params. This was the fragile handoff point where agents would forget `cleanup: "keep"`, use wrong models, or corrupt session state. Moving dispatch into the plugin eliminates that entire class of errors.

**Session persistence:** Sessions created via `sessions.patch` persist indefinitely (no auto-cleanup). The plugin manages lifecycle explicitly through the `health` tool.

**What we trade off vs. registered sub-agents:**

| Feature | Sub-agent system | Plugin-controlled | DevClaw equivalent |
|---|---|---|---|
| Auto-reporting | Sub-agent reports to parent | No | Heartbeat polls for completion |
| Concurrency control | `maxConcurrent` | No | `work_start` checks `active` flag |
| Lifecycle tracking | Parent-child registry | No | `projects.json` tracks all sessions |
| Timeout detection | `runTimeoutSeconds` | No | `health` flags stale >2h |
| Cleanup | Auto-archive | No | `health` manual cleanup |

DevClaw provides equivalent guardrails for everything except auto-reporting, which the heartbeat handles.

## Roles

DevClaw ships with three built-in roles, defined in `lib/roles/registry.ts`. All roles use the same level scheme (junior/medior/senior) — levels describe task complexity, not the role.

| Role | ID | Levels | Default Level | Completion Results |
|---|---|---|---|---|
| Developer | `developer` | junior, medior, senior | medior | done, review, blocked |
| Tester | `tester` | junior, medior, senior | medior | pass, fail, refine, blocked |
| Architect | `architect` | junior, senior | junior | done, blocked |

Roles are extensible — add a new entry to `ROLE_REGISTRY` and corresponding workflow states to get a new role. The `workflow.yaml` config can also override levels, models, and emoji per role, or disable a role entirely (`architect: false`).

## System overview

```mermaid
graph TB
    subgraph "Telegram"
        H[Human]
        TG[Group Chat]
    end

    subgraph "OpenClaw Runtime"
        MS[Main Session<br/>orchestrator agent]
        GW[Gateway RPC<br/>sessions.patch / sessions.list]
        CLI[openclaw gateway call agent]
        DEV_J[DEVELOPER session<br/>junior]
        DEV_M[DEVELOPER session<br/>medior]
        DEV_S[DEVELOPER session<br/>senior]
        TST_M[TESTER session<br/>medior]
        ARCH[ARCHITECT session<br/>junior]
    end

    subgraph "DevClaw Plugin"
        WS[work_start]
        WF[work_finish]
        TCR[task_create]
        ST[status]
        SH[health]
        PR[project_register]
        DS[setup]
        TIER[Level Resolver]
        PJ[projects.json]
        AL[audit.log]
    end

    subgraph "External"
        GL[Issue Tracker]
        REPO[Git Repository]
    end

    H -->|messages| TG
    TG -->|delivers| MS
    MS -->|announces| TG

    MS -->|calls| WS
    MS -->|calls| WF
    MS -->|calls| TCR
    MS -->|calls| ST
    MS -->|calls| SH
    MS -->|calls| PR
    MS -->|calls| DS

    WS -->|resolves level| TIER
    WS -->|transitions labels| GL
    WS -->|reads/writes| PJ
    WS -->|appends| AL
    WS -->|creates session| GW
    WS -->|dispatches task| CLI

    WF -->|transitions labels| GL
    WF -->|closes/reopens| GL
    WF -->|reads/writes| PJ
    WF -->|git pull| REPO
    WF -->|tick dispatch| CLI
    WF -->|appends| AL

    TCR -->|creates issue| GL
    TCR -->|appends| AL

    ST -->|lists issues by label| GL
    ST -->|reads| PJ
    ST -->|appends| AL

    SH -->|reads/writes| PJ
    SH -->|checks sessions| GW
    SH -->|reverts labels| GL
    SH -->|appends| AL

    PR -->|creates labels| GL
    PR -->|writes entry| PJ
    PR -->|appends| AL

    CLI -->|sends task| DEV_J
    CLI -->|sends task| DEV_M
    CLI -->|sends task| DEV_S
    CLI -->|sends task| TST_M
    CLI -->|sends task| ARCH

    DEV_J -->|writes code, creates PRs| REPO
    DEV_M -->|writes code, creates PRs| REPO
    DEV_S -->|writes code, creates PRs| REPO
    TST_M -->|reviews code, tests| REPO
```

## End-to-end flow: human to sub-agent

This diagram shows the complete path from a human message in Telegram through to a sub-agent session working on code:

```mermaid
sequenceDiagram
    participant H as Human (Telegram)
    participant TG as Telegram Channel
    participant MS as Main Session<br/>(orchestrator)
    participant DC as DevClaw Plugin
    participant GW as Gateway RPC
    participant CLI as openclaw gateway call agent
    participant DEV as DEVELOPER Session<br/>(medior)
    participant GL as Issue Tracker

    Note over H,GL: Issue exists in queue (To Do)

    H->>TG: "check status" (or heartbeat triggers)
    TG->>MS: delivers message
    MS->>DC: status()
    DC->>GL: list issues by label "To Do"
    DC-->>MS: { toDo: [#42], developer: idle }

    Note over MS: Decides to pick up #42 for DEVELOPER as medior

    MS->>DC: work_start({ issueId: 42, role: "developer", level: "medior", ... })
    DC->>DC: resolve level "medior" → model ID
    DC->>DC: lookup developer.sessions.medior → null (first time)
    DC->>GL: transition label "To Do" → "Doing"
    DC->>GW: sessions.patch({ key: new-session-key, model: "anthropic/claude-sonnet-4-5" })
    DC->>CLI: openclaw gateway call agent --params { sessionKey, message }
    CLI->>DEV: creates session, delivers task
    DC->>DC: store session key in projects.json + append audit.log
    DC-->>MS: { success: true, announcement: "🔧 Spawning DEVELOPER (medior) for #42" }

    MS->>TG: "🔧 Spawning DEVELOPER (medior) for #42: Add login page"
    TG->>H: sees announcement

    Note over DEV: Works autonomously — reads code, writes code, creates PR
    Note over DEV: Calls work_finish when done

    DEV->>DC: work_finish({ role: "developer", result: "done", ... })
    DC->>GL: transition label "Doing" → "To Test"
    DC->>DC: deactivate worker (sessions preserved)
    DC-->>DEV: { announcement: "✅ DEVELOPER DONE #42" }

    MS->>TG: "✅ DEVELOPER DONE #42 — moved to TESTER queue"
    TG->>H: sees announcement
```

On the **next DEVELOPER task** for this project that also assigns medior:

```mermaid
sequenceDiagram
    participant MS as Main Session
    participant DC as DevClaw Plugin
    participant CLI as openclaw gateway call agent
    participant DEV as DEVELOPER Session<br/>(medior, existing)

    MS->>DC: work_start({ issueId: 57, role: "developer", level: "medior", ... })
    DC->>DC: resolve level "medior" → model ID
    DC->>DC: lookup developer.sessions.medior → existing key!
    Note over DC: No sessions.patch needed — session already exists
    DC->>CLI: openclaw gateway call agent --params { sessionKey, message }
    CLI->>DEV: delivers task to existing session (has full codebase context)
    DC-->>MS: { success: true, announcement: "⚡ Sending DEVELOPER (medior) for #57" }
```

Session reuse saves ~50K tokens per task by not re-reading the codebase.

## Complete ticket lifecycle

This traces a single issue from creation to completion, showing every component interaction, data write, and message.

### Phase 1: Issue created

Issues are created by the orchestrator agent or by sub-agent sessions via `task_create` or directly via `gh`/`glab`. The orchestrator can create issues based on user requests in Telegram, backlog planning, or QA feedback. Sub-agents can also create issues when they discover bugs during development.

```
Orchestrator Agent → Issue Tracker: creates issue #42 with label "Planning"
```

**State:** Issue tracker has issue #42 labeled "Planning". Nothing in DevClaw yet.

### Phase 2: Heartbeat detects work

```
Heartbeat triggers → Orchestrator calls status()
```

```mermaid
sequenceDiagram
    participant A as Orchestrator
    participant QS as status
    participant GL as Issue Tracker
    participant PJ as projects.json
    participant AL as audit.log

    A->>QS: status({ projectGroupId: "-123" })
    QS->>PJ: readProjects()
    PJ-->>QS: { developer: idle, tester: idle }
    QS->>GL: list issues by label "To Do"
    GL-->>QS: [{ id: 42, title: "Add login page" }]
    QS->>GL: list issues by label "To Test"
    GL-->>QS: []
    QS->>GL: list issues by label "To Improve"
    GL-->>QS: []
    QS->>AL: append { event: "status", ... }
    QS-->>A: { developer: idle, queue: { toDo: [#42] } }
```

**Orchestrator decides:** DEVELOPER is idle, issue #42 is in To Do → pick it up. Evaluates complexity → assigns medior level.

### Phase 3: DEVELOPER pickup

The plugin handles everything end-to-end — level resolution, session lookup, label transition, state update, **and** task dispatch to the worker session. The agent's only job after is to post the announcement.

```mermaid
sequenceDiagram
    participant A as Orchestrator
    participant WS as work_start
    participant GL as Issue Tracker
    participant TIER as Level Resolver
    participant GW as Gateway RPC
    participant CLI as openclaw gateway call agent
    participant PJ as projects.json
    participant AL as audit.log

    A->>WS: work_start({ issueId: 42, role: "developer", projectGroupId: "-123", level: "medior" })
    WS->>PJ: readProjects()
    WS->>GL: getIssue(42)
    GL-->>WS: { title: "Add login page", labels: ["To Do"] }
    WS->>WS: Verify label is "To Do"
    WS->>TIER: resolve "medior" → "anthropic/claude-sonnet-4-5"
    WS->>PJ: lookup developer.sessions.medior
    WS->>GL: transitionLabel(42, "To Do", "Doing")
    alt New session
        WS->>GW: sessions.patch({ key: new-key, model: "anthropic/claude-sonnet-4-5" })
    end
    WS->>CLI: openclaw gateway call agent --params { sessionKey, message }
    WS->>PJ: activateWorker + store session key
    WS->>AL: append work_start + model_selection
    WS-->>A: { success: true, announcement: "🔧 ..." }
```

**Writes:**
- `Issue Tracker`: label "To Do" → "Doing"
- `projects.json`: workers.developer.active=true, issueId="42", level="medior", sessions.medior=key
- `audit.log`: 2 entries (work_start, model_selection)
- `Session`: task message delivered to worker session via CLI

### Phase 4: DEVELOPER works

```
DEVELOPER sub-agent session → reads codebase, writes code, creates PR
DEVELOPER sub-agent session → calls work_finish({ role: "developer", result: "done", ... })
```

This happens inside the OpenClaw session. The worker calls `work_finish` directly for atomic state updates. If the worker discovers unrelated bugs, it calls `task_create` to file them.

### Phase 5: DEVELOPER complete (worker self-reports)

```mermaid
sequenceDiagram
    participant DEV as DEVELOPER Session
    participant WF as work_finish
    participant GL as Issue Tracker
    participant PJ as projects.json
    participant AL as audit.log
    participant REPO as Git Repo

    DEV->>WF: work_finish({ role: "developer", result: "done", projectGroupId: "-123", summary: "Login page with OAuth" })
    WF->>PJ: readProjects()
    PJ-->>WF: { developer: { active: true, issueId: "42" } }
    WF->>REPO: git pull
    WF->>PJ: deactivateWorker(-123, developer)
    Note over PJ: active→false, issueId→null<br/>sessions map PRESERVED
    WF->>GL: transitionLabel "Doing" → "To Test"
    WF->>AL: append { event: "work_finish", role: "developer", result: "done" }

    WF->>WF: tick queue (fill free slots)
    Note over WF: Scheduler sees "To Test" issue, TESTER slot free → dispatches TESTER
    WF-->>DEV: { announcement: "✅ DEVELOPER DONE #42", tickPickups: [...] }
```

**Writes:**
- `Git repo`: pulled latest (has DEVELOPER's merged code)
- `projects.json`: workers.developer.active=false, issueId=null (sessions map preserved for reuse)
- `Issue Tracker`: label "Doing" → "To Test"
- `audit.log`: 1 entry (work_finish) + tick entries if workers dispatched

### Phase 5b: DEVELOPER requests review (alternative path)

Instead of merging the PR themselves, a developer can leave it open for human review:

```mermaid
sequenceDiagram
    participant DEV as DEVELOPER Session
    participant WF as work_finish
    participant GL as Issue Tracker
    participant PJ as projects.json

    DEV->>WF: work_finish({ role: "developer", result: "review", ... })
    WF->>GL: transitionLabel "Doing" → "In Review"
    WF->>PJ: deactivateWorker (sessions preserved)
    WF-->>DEV: { announcement: "👀 DEVELOPER REVIEW #42" }
```

The issue sits in "In Review" until the heartbeat's **review pass** detects the PR has been approved. DevClaw then auto-merges the PR and transitions to "To Test". If the merge fails (e.g. conflicts), the issue moves to "To Improve" where a developer is auto-dispatched to resolve conflicts.

### Phase 6: TESTER pickup

Same as Phase 3, but with `role: "tester"`. Label transitions "To Test" → "Testing". Level selection determines which tester session is used.

### Phase 7: TESTER result (4 possible outcomes)

#### 7a. TESTER Pass

```mermaid
sequenceDiagram
    participant TST as TESTER Session
    participant WF as work_finish
    participant GL as Issue Tracker
    participant PJ as projects.json
    participant AL as audit.log

    TST->>WF: work_finish({ role: "tester", result: "pass", projectGroupId: "-123" })
    WF->>PJ: deactivateWorker(-123, tester)
    WF->>GL: transitionLabel(42, "Testing", "Done")
    WF->>GL: closeIssue(42)
    WF->>AL: append { event: "work_finish", role: "tester", result: "pass" }
    WF-->>TST: { announcement: "🎉 TESTER PASS #42. Issue closed." }
```

**Ticket complete.** Issue closed, label "Done".

#### 7b. TESTER Fail

```mermaid
sequenceDiagram
    participant TST as TESTER Session
    participant WF as work_finish
    participant GL as Issue Tracker
    participant PJ as projects.json
    participant AL as audit.log

    TST->>WF: work_finish({ role: "tester", result: "fail", projectGroupId: "-123", summary: "OAuth redirect broken" })
    WF->>PJ: deactivateWorker(-123, tester)
    WF->>GL: transitionLabel(42, "Testing", "To Improve")
    WF->>GL: reopenIssue(42)
    WF->>AL: append { event: "work_finish", role: "tester", result: "fail" }
    WF-->>TST: { announcement: "❌ TESTER FAIL #42 — OAuth redirect broken. Sent back to DEVELOPER." }
```

**Cycle restarts:** Issue goes to "To Improve". Next heartbeat, DEVELOPER picks it up again (Phase 3, but from "To Improve" instead of "To Do").

#### 7c. TESTER Refine

```
Label: "Testing" → "Refining"
```

Issue needs human decision. Pipeline pauses until human moves it to "To Do" or closes it.

#### 7d. Blocked (DEVELOPER or TESTER)

```
DEVELOPER Blocked: "Doing" → "Refining"
TESTER Blocked:    "Testing" → "Refining"
```

Worker cannot complete (missing info, environment errors, etc.). Issue enters hold state for human decision. The human can move it back to "To Do" to retry or take other action.

### Completion enforcement

Three layers guarantee that `work_finish` always runs:

1. **Completion contract** — Every task message sent to a worker session includes a mandatory `## MANDATORY: Task Completion` section listing available results and requiring `work_finish` even on failure. Workers are instructed to use `"blocked"` if stuck.

2. **Blocked result** — All roles can use `"blocked"` to gracefully hand off to a human. Developer blocked: `Doing → Refining`. Tester blocked: `Testing → Refining`. This gives workers an escape hatch instead of silently dying.

3. **Stale worker watchdog** — The heartbeat's health check detects workers active for >2 hours. With `fix=true`, it deactivates the worker and reverts the label back to queue. This catches sessions that crashed, ran out of context, or otherwise failed without calling `work_finish`. The `health` tool provides the same check for manual invocation.

### Phase 8: Heartbeat (continuous)

The heartbeat runs periodically (via background service or manual `work_heartbeat` trigger). It combines health check + review polling + queue scan:

```mermaid
sequenceDiagram
    participant HB as Heartbeat Service
    participant SH as health check
    participant RV as review pass
    participant TK as projectTick
    participant WS as work_start (dispatch)
    Note over HB: Tick triggered (every 60s)

    HB->>SH: checkWorkerHealth per project per role
    Note over SH: Checks for zombies, stale workers
    SH-->>HB: { fixes applied }

    HB->>RV: reviewPass per project
    Note over RV: Polls PR status for "In Review" issues
    RV-->>HB: { transitions made }

    HB->>TK: projectTick per project
    Note over TK: Scans queue: To Improve > To Test > To Do
    TK->>WS: dispatchTask (fill free slots)
    WS-->>TK: { dispatched }
    TK-->>HB: { pickups, skipped }
```

## Worker instructions (bootstrap hook)

Role-specific instructions (coding standards, deployment steps, completion rules) are injected into worker sessions via the `agent:bootstrap` hook — not appended to the task message.

```mermaid
sequenceDiagram
    participant GW as Gateway
    participant BH as Bootstrap Hook
    participant FS as Filesystem

    Note over GW: Worker session starts
    GW->>BH: agent:bootstrap event (sessionKey, bootstrapFiles[])
    BH->>BH: Parse session key → { projectName, role }
    BH->>FS: Load role instructions (project-specific → default)
    FS-->>BH: content + source path
    BH->>BH: Push WORKER_INSTRUCTIONS.md into bootstrapFiles
    BH-->>GW: bootstrapFiles now includes role instructions
```

**Resolution order:**
1. `devclaw/projects/<project>/prompts/<role>.md` (project-specific)
2. `devclaw/prompts/<role>.md` (workspace default)

The source path is logged for production traceability: `Bootstrap hook: injected developer instructions for project "my-app" from /path/to/prompts/developer.md`.

## Data flow map

Every piece of data and where it lives:

```
┌─────────────────────────────────────────────────────────────────┐
│ Issue Tracker (source of truth for tasks)                       │
│                                                                 │
│  Issue #42: "Add login page"                                    │
│  Labels: [Planning | To Do | Doing | To Test | Testing | ...]   │
│  State: open / closed                                           │
│  PRs: linked pull/merge requests (status polled for In Review)  │
│  Created by: orchestrator (task_create), workers, or humans     │
└─────────────────────────────────────────────────────────────────┘
        ↕ gh/glab CLI (read/write, auto-detected)
        ↕ cockatiel resilience: retry + circuit breaker
┌─────────────────────────────────────────────────────────────────┐
│ DevClaw Plugin (orchestration logic)                            │
│                                                                 │
│  setup          → agent creation + workspace + model config     │
│  work_start     → level + label + dispatch (e2e)                │
│  work_finish    → label + state + git pull + tick queue          │
│  task_create    → create issue in tracker                       │
│  task_update    → manual label state change                     │
│  task_comment   → add comment to issue                          │
│  status         → read labels + read state                      │
│  health         → check sessions + fix zombies                  │
│  project_register → labels + prompts + state init (one-time)    │
│  design_task    → architect dispatch                            │
│                                                                 │
│  Bootstrap hook → injects role instructions into worker sessions│
│  Review pass    → polls PR status, auto-merges approved PRs     │
│  Config loader  → three-layer merge + Zod validation            │
└─────────────────────────────────────────────────────────────────┘
        ↕ atomic file I/O          ↕ OpenClaw CLI (plugin shells out)
┌────────────────────────────────┐ ┌──────────────────────────────┐
│ devclaw/projects.json          │ │ OpenClaw Gateway + CLI       │
│                                │ │ (called by plugin, not agent)│
│  Per project:                  │ │                              │
│    workers:                    │ │  openclaw gateway call       │
│      developer:                │ │    sessions.patch → create   │
│        active, issueId, level  │ │    sessions.list  → health   │
│        sessions:               │ │    sessions.delete → cleanup │
│          junior: <key>         │ │                              │
│          medior: <key>         │ │  openclaw gateway call agent │
│          senior: <key>         │ │    --params { sessionKey,    │
│      tester:                   │ │      message, agentId }      │
│        active, issueId, level  │ │    → dispatches to session   │
│        sessions:               │ │                              │
│          junior: <key>         │ │                              │
│          medior: <key>         │ │                              │
│          senior: <key>         │ │                              │
│      architect:                │ │                              │
│        sessions:               │ │                              │
│          junior: <key>         │ │                              │
│          senior: <key>         │ │                              │
└────────────────────────────────┘ └──────────────────────────────┘
        ↕ append-only
┌─────────────────────────────────────────────────────────────────┐
│ devclaw/log/audit.log (observability)                           │
│                                                                 │
│  NDJSON, one line per event:                                    │
│  work_start, work_finish, model_selection,                      │
│  status, health, task_create, task_update,                      │
│  task_comment, project_register, setup, heartbeat_tick          │
│                                                                 │
│  Query: cat audit.log | jq 'select(.event=="work_start")'      │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ Telegram / WhatsApp (user-facing messages)                      │
│                                                                 │
│  Per group chat:                                                │
│    "🔧 Spawning DEVELOPER (medior) for #42: Add login page"    │
│    "⚡ Sending DEVELOPER (medior) for #57: Fix validation"      │
│    "✅ DEVELOPER DONE #42 — Login page with OAuth."             │
│    "👀 DEVELOPER REVIEW #42 — PR open for review."              │
│    "🎉 TESTER PASS #42. Issue closed."                          │
│    "❌ TESTER FAIL #42 — OAuth redirect broken."                │
│    "🚫 DEVELOPER BLOCKED #42 — Missing dependencies."          │
│    "🚫 TESTER BLOCKED #42 — Env not available."                │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ Git Repository (codebase)                                       │
│                                                                 │
│  DEVELOPER sub-agent sessions: read code, write code, create PRs│
│  TESTER sub-agent sessions: read code, run tests, review PRs    │
│  ARCHITECT sub-agent sessions: research, design, recommend      │
│  work_finish (developer done): git pull to sync latest          │
└─────────────────────────────────────────────────────────────────┘
```

## Scope boundaries

What DevClaw controls vs. what it delegates:

```mermaid
graph LR
    subgraph "DevClaw controls (deterministic)"
        L[Label transitions]
        S[Worker state]
        PR[Project registration]
        SETUP[Agent + workspace setup]
        SD[Session dispatch<br/>create + send via CLI]
        AC[Scheduling<br/>tick queue after work_finish]
        RI[Role instructions<br/>injected via bootstrap hook]
        RV[Review polling<br/>PR approved → auto-merge]
        A[Audit logging]
        Z[Zombie cleanup]
        CFG[Config validation<br/>Zod + integrity checks]
        RES[Provider resilience<br/>retry + circuit breaker]
    end

    subgraph "Orchestrator handles (planning only)"
        MSG[Telegram announcements]
        HB[Heartbeat scheduling]
        DEC[Task prioritization]
        M[Developer assignment<br/>junior/medior/senior]
        READ[Code reading for context]
        PLAN[Requirements & planning]
    end

    subgraph "Sub-agent sessions handle"
        CR[Code writing]
        MR[PR creation/review]
        WF_W[Task completion<br/>via work_finish]
        BUG[Bug filing<br/>via task_create]
    end

    subgraph "External"
        DEPLOY[Deployment]
        HR[Human decisions]
    end
```

**Key boundary:** The orchestrator is a planner and dispatcher — it never writes code. All implementation work (code edits, git operations, tests) must go through sub-agent sessions via the `task_create` → `work_start` pipeline. This ensures audit trails, level selection, and testing for every code change.

## IssueProvider abstraction

All issue tracker operations go through the `IssueProvider` interface, defined in `lib/providers/provider.ts`. This abstraction allows DevClaw to support multiple issue trackers without changing tool logic.

**Interface methods:**
- `ensureLabel` / `ensureAllStateLabels` — idempotent label creation
- `createIssue` — create issue with label and assignees
- `listIssuesByLabel` / `getIssue` — issue queries
- `transitionLabel` — atomic label state transition (unlabel + label)
- `closeIssue` / `reopenIssue` — issue lifecycle
- `hasStateLabel` / `getCurrentStateLabel` — label inspection
- `getPrStatus` — get PR/MR state (open, merged, approved, none)
- `hasMergedMR` / `getMergedMRUrl` — MR/PR verification
- `addComment` — add comment to issue
- `healthCheck` — verify provider connectivity

**Provider resilience:** All provider calls are wrapped with cockatiel retry (3 attempts, exponential backoff) + circuit breaker (opens after 5 consecutive failures, half-opens after 30s). See `lib/providers/resilience.ts`.

**Current providers:**
- **GitHub** (`lib/providers/github.ts`) — wraps `gh` CLI
- **GitLab** (`lib/providers/gitlab.ts`) — wraps `glab` CLI

**Planned providers:**
- **Jira** — via REST API

Provider selection is handled by `createProvider()` in `lib/providers/index.ts`. Auto-detects GitHub vs GitLab from the git remote URL.

## Configuration system

DevClaw uses a three-layer config system with `workflow.yaml` files:

```
Layer 1: Built-in defaults (ROLE_REGISTRY + DEFAULT_WORKFLOW)
Layer 2: Workspace:  <workspace>/devclaw/workflow.yaml
Layer 3: Project:    <workspace>/devclaw/projects/<project>/workflow.yaml
```

Each layer can override roles (levels, models, emoji), workflow states/transitions, and timeouts. Config is validated with Zod schemas at load time, with cross-reference integrity checks (transition targets exist, queue states have roles, terminal states have no outgoing transitions).

See [CONFIGURATION.md](CONFIGURATION.md) for the full reference.

## Error recovery

| Failure | Detection | Recovery |
|---|---|---|
| Session dies mid-task | `health` checks via `sessions.list` Gateway RPC | `fix=true`: reverts label, clears active state. Next heartbeat picks up task again (creates fresh session for that level). |
| gh/glab command fails | Cockatiel retry (3 attempts), then circuit breaker | Circuit opens after 5 consecutive failures, prevents hammering. Plugin catches and returns error. |
| `openclaw gateway call agent` fails | Plugin catches error during dispatch | Plugin rolls back: reverts label, clears active state. Returns error. No orphaned state. |
| `sessions.patch` fails | Plugin catches error during session creation | Plugin rolls back label transition. Returns error. |
| projects.json corrupted | Tool can't parse JSON | Manual fix needed. Atomic writes (temp+rename) prevent partial writes. File locking prevents concurrent races. |
| Label out of sync | `work_start` verifies label before transitioning | Throws error if label doesn't match expected state. |
| Worker already active | `work_start` checks `active` flag | Throws error: "DEVELOPER already active on project". Must complete current task first. |
| Stale worker (>2h) | `health` and heartbeat health check | `fix=true`: deactivates worker, reverts label to queue. Task available for next pickup. |
| Worker stuck/blocked | Worker calls `work_finish` with `"blocked"` | Deactivates worker, transitions to "Refining" (hold state). Requires human decision to proceed. |
| Config invalid | Zod schema validation at load time | Clear error message with field path. Prevents startup with broken config. |
| `project_register` fails | Plugin catches error during label creation or state write | Clean error returned. Labels are idempotent, projects.json not written until all labels succeed. |

## File locations

| File | Location | Purpose |
|---|---|---|
| Plugin source | `~/.openclaw/extensions/devclaw/` | Plugin code |
| Plugin manifest | `~/.openclaw/extensions/devclaw/openclaw.plugin.json` | Plugin registration |
| Agent config | `~/.openclaw/openclaw.json` | Agent definition + tool permissions + model config |
| Worker state | `<workspace>/devclaw/projects.json` | Per-project worker state |
| Workflow config (workspace) | `<workspace>/devclaw/workflow.yaml` | Workspace-level role/workflow overrides |
| Workflow config (project) | `<workspace>/devclaw/projects/<project>/workflow.yaml` | Project-specific overrides |
| Default role instructions | `<workspace>/devclaw/prompts/<role>.md` | Default `developer.md`, `tester.md`, `architect.md` |
| Project role instructions | `<workspace>/devclaw/projects/<project>/prompts/<role>.md` | Per-project role instruction overrides |
| Audit log | `<workspace>/devclaw/log/audit.log` | NDJSON event log |
| Session transcripts | `~/.openclaw/agents/<agent>/sessions/<uuid>.jsonl` | Conversation history per session |
| Git repos | `~/git/<project>/` | Project source code |
