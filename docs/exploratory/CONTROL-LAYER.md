# Control Layers

How DevClaw controls agent behavior, from least to most reliable.

---

## The Stack

```
                    Reliability

  Prompt            ░░░░░░░░░░  Soft — LLM can ignore
  Tool Schema       ▓▓▓▓▓▓░░░░  Medium — call rejected on wrong values
  Code              ██████████  Hard — deterministic, throws on violation
  Config            ██████████  Hard — validated at load time
  Heartbeat         ██████████  Hard — autonomous, zero tokens
  Platform          ██████████  External — GitHub/GitLab enforced
```

---

## Layer 1: Prompts (Soft)

Instructions injected into the LLM context. The agent *should* follow them but *can* ignore, misinterpret, or forget them. No enforcement mechanism.

### What's controlled

| File | Injected via | Controls |
|---|---|---|
| `devclaw/prompts/architect.md` | Bootstrap hook → `WORKER_INSTRUCTIONS.md` | Research 3+ alternatives, post findings, create task before finishing |
| `devclaw/prompts/developer.md` | Bootstrap hook → `WORKER_INSTRUCTIONS.md` | Work in worktrees, don't merge PR, no closing keywords in PR description |
| `devclaw/prompts/reviewer.md` | Bootstrap hook → `WORKER_INSTRUCTIONS.md` | Review diff only, call task_comment first, then approve/reject |
| `devclaw/prompts/tester.md` | Bootstrap hook → `WORKER_INSTRUCTIONS.md` | Run tests, always call task_comment with findings |
| `AGENTS.md` | Workspace context file | Orchestrator must never write code, priority ordering, tool restrictions |
| `SOUL.md` / `IDENTITY.md` | Workspace context file | Personality, communication style |
| `buildTaskMessage()` | Appended to task message | Mandatory completion block: "you MUST call work_finish" with valid results |

### Prompt resolution

Role prompts are resolved per-project with fallback:
1. `devclaw/projects/<project>/prompts/<role>.md`
2. `devclaw/prompts/<role>.md`

### What can go wrong

- Architect calls `work_finish(done)` without creating a task — **no code guard**
- Developer uses `Closes #42` in PR description — GitHub auto-closes, bypasses review lifecycle — **no code guard**
- Tester calls `work_finish(pass)` without posting a `task_comment` — **no code guard**
- Orchestrator writes code directly instead of dispatching a worker — **no code guard**

---

## Layer 2: Tool Schemas (Medium)

JSON Schema constraints on tool parameters. The LLM framework **rejects the call** if the schema is violated — the tool never executes. But the LLM can choose not to call the tool at all.

### What's enforced

| Tool | Constraint | Type |
|---|---|---|
| `work_finish` | `role` must be one of `["developer","tester","architect","reviewer"]` | `enum` |
| `work_finish` | `result` must be one of `["done","pass","fail","refine","blocked","approve","reject"]` | `enum` |
| `task_create` | `label` must be a valid workflow state label | `enum` |
| `research_task` | `complexity` must be `"simple"`, `"medium"`, or `"complex"` | `enum` |
| `task_comment` | `authorRole` must be a known role or `"orchestrator"` | `enum` |
| `task_set_level` | `level` must be a valid role level | `enum` |
| All tools | `projectSlug` is required | `required` |

### Soft instructions in schemas

Tool descriptions include `IMPORTANT:` text. These are read by the LLM but not enforced:
- `task_create`: "Always creates in Planning unless the user explicitly asks to start work immediately"
- `research_task`: "Provide a detailed description with enough background context"

---

## Layer 3: Code (Hard)

Deterministic checks in `execute()` functions. These **throw errors** — the LLM gets the error back and must retry or give up. No prompt can bypass them.

### Guards

| Check | Where | What it prevents |
|---|---|---|
| `isValidResult(role, result)` | `work-finish.ts` | Developer calling `pass`, tester calling `approve`, etc. |
| `worker.active` guard | `work-finish.ts` | Finishing work that was never started |
| `validatePrExistsForDeveloper()` | `work-finish.ts` | Developer marking `done` without an open PR |
| `getRule(role, result, workflow)` | `work-finish.ts` | Any completion with no matching state transition |
| `worker.active` slot check | `work-start.ts` | Two workers of the same role running simultaneously |
| Sequential execution check | `work-start.ts` | Any role running while another is active (sequential mode) |
| Role mismatch guard | `work-start.ts` | Dispatching a tester to a "To Do" issue |
| State label check | `work-start.ts` | Dispatching to an issue with no recognized state |
| Editable-state guard | `task-edit-body.ts` | Editing issue body while work is in progress |
| Empty body check | `task-comment.ts` | Posting an empty comment |
| Required field checks | `research-task.ts` | Creating a research task without description |

### Computed behavior (no LLM input)

| Mechanism | Where | What it does |
|---|---|---|
| Session key naming | `dispatch.ts` | Deterministic: `agent:{id}:subagent:{project}-{role}-{level}` |
| Review routing label | `dispatch.ts` | Computed from policy + level, applied as `review:human` or `review:agent` |
| Level selection heuristic | `model-selector.ts` | Keywords in title/description → junior/medior/senior |
| Context budget clearing | `dispatch.ts` | Clears session when context > budget threshold |
| Eyes reaction (managed marker) | `task-create.ts`, `dispatch.ts` | Applied automatically, used as filter in heartbeat |

---

## Layer 4: Config (Hard — validated at load time)

Three-layer merge: **built-in defaults → workspace yaml → project yaml**. Validated by Zod schema + workflow integrity checks. Invalid config is rejected at load time.

### What's configurable

| Setting | Default | Effect |
|---|---|---|
| `workflow.reviewPolicy` | `human` | `human` / `agent` / `auto` — controls review routing |
| `roles.<role>.models` | Registry defaults | Which model runs at each level |
| `roles.<role>.levels` | Registry defaults | Available level names |
| `roles.<role>.completionResults` | Registry defaults | Valid results for `work_finish` |
| `roles.<role>: false` | Enabled | Disables a role entirely |
| `workflow.states` | `DEFAULT_WORKFLOW` | Full statechart override |
| `timeouts.staleWorkerHours` | 2 | When heartbeat flags stale workers |
| `timeouts.sessionContextBudget` | 0.6 | Context ratio for session clearing |
| `timeouts.dispatchMs` | 600,000 | Max dispatch turn time |

### Per-issue overrides (labels)

| Label | Effect |
|---|---|
| `review:human` | Force human PR review |
| `review:agent` | Force agent PR review |
| `review:skip` | Skip review |
| `test:skip` | Skip test phase |

---

## Layer 5: Heartbeat (Hard — autonomous, zero tokens)

Runs as a `setInterval` inside the gateway. No LLM involved. Fully deterministic.

### Health pass — auto-fixes

| Condition | Fix |
|---|---|
| Session dead (gateway says missing) | Revert label to queue, deactivate worker |
| Label mismatch (label changed externally) | Deactivate worker |
| Stale worker (active > N hours) | Revert label to queue, deactivate |
| Orphaned label (no tracked worker) | Revert label to queue |
| Orphaned session (not in any project) | Delete gateway session |
| Context overflow (`abortedLastRun`) | Revert label, clear session, deactivate |

### Review pass — PR polling

For issues in review states with `review:human` + eyes marker:
- PR approved/merged → merge PR, close issue → Done
- Changes requested / has comments → To Improve (developer re-dispatched)
- Merge conflict → To Improve
- Merge failure → To Improve

### Tick pass — queue scanning

Fills free worker slots by priority. Respects: one worker per role, sequential mode, maxPickupsPerTick (default 4), review/test skip labels.

---

## Layer 6: Platform (External)

GitHub/GitLab settings that DevClaw reads but does not configure.

| Setting | Effect on DevClaw |
|---|---|
| Branch protection | Merge API fails if checks not met → heartbeat catches, transitions to To Improve |
| Required reviews | PR not reported as approved until reviewer approves |
| CI checks | DevClaw doesn't check these; branch protection gates the merge |
| CODEOWNERS | Not referenced by DevClaw |

---

## Reliability Summary

| What | Enforced by | Can agent bypass? |
|---|---|---|
| Architect must create task before finishing | Prompt | Yes |
| Developer must not use closing keywords | Prompt | Yes |
| Tester must post comment before completing | Prompt | Yes |
| Orchestrator must not write code | Prompt | Yes |
| Tool params must match schema types/enums | Tool framework | No (call rejected) |
| Developer can't finish without a PR | Code (`validatePrExistsForDeveloper`) | No |
| Can't finish with wrong role:result pair | Code (`isValidResult`) | No |
| Can't run two workers of same role | Code (slot check) | No |
| Review routing (human/agent/auto) | Code (computed label) | No |
| Auto-merge only for managed issues | Code (eyes reaction filter) | No |
| Stale worker cleanup | Heartbeat (autonomous) | N/A |
| PR approval detection | Heartbeat (autonomous) | N/A |
| Branch protection | GitHub/GitLab | N/A |
