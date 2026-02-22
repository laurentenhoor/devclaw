# DevClaw Advanced Scenarios & Best Practices

Welcome to **DEMO2**! This guide builds on [DEMO.md](DEMO.md) with advanced workflows, multi-role scenarios, and best practices for managing large development teams.

## Advanced Workflows

### Scenario 1: Complex Feature with Architecture Phase

You're building a critical feature that needs architectural review before development.

#### Step 1: Create an Architecture Issue

```
"Create an issue: Research: Implement session persistence strategy
Description: We need to persist user sessions across server restarts. 
Current implementation uses in-memory Map. Constraints: must work with 
SQLite (already a dependency), max 50ms latency. Consider tradeoffs 
between SQLite and file-based approaches."
```

The agent creates issue #50 in **Planning**.

#### Step 2: Move to Research

```
"Move #50 to To Research"
```

The orchestrator dispatches a **senior architect**:

```
⚡ Sending ARCHITECT (senior) for #50: Research session persistence strategy
```

#### Step 3: Architect Research & Propose

The architect researches and posts detailed findings as comments:

```
## Research Summary

### Findings
- **SQLite Approach**: Pros: persistent, queryable, ACID guarantees.
  Cons: adds ~5-15ms per read. Can optimize with in-memory cache layer.
- **File-based**: Pros: simpler, faster reads. Cons: no transactions, 
  manual cleanup needed, harder to query.

### Recommendation
Use SQLite with Redis-style in-memory cache. Gives us persistence, 
ACID guarantees, AND sub-5ms p99 latency.

### Implementation Tasks
- #51: Implement SQLite session store
- #52: Add in-memory cache layer  
- #53: Write migration script for existing sessions
- #54: Add integration tests
```

#### Step 4: Approve Architecture & Move Tasks to Queue

You review the findings and move tasks to **To Do**:

```
"Move #51, #52, #53, #54 to To Do"
```

The orchestrator now dispatches developers:

```
⚡ Sending DEV (medior) for #51: Implement SQLite session store
⚡ Sending DEV (junior) for #52: Add in-memory cache layer
⚡ Sending DEV (medior) for #53: Add migration script for sessions
```

#### Step 5: Development & Testing Phases

Developers create PRs; reviewers approve. If a reviewer requests changes:

```
🔄 PR changes requested for #51 — Back to DEV.
⚡ Sending DEV (medior) for #51: Implement SQLite session store
```

Tests are run automatically or by a tester role before merging.

---

### Scenario 2: Hotfix in Production (High Priority)

A critical bug appears in production. You need to ship a fix immediately.

#### Step 1: Create Hotfix Issue with Escalation

```
"Create an issue: Fix: Critical SQL injection vulnerability in login form
Description: Security issue discovered in POST /login endpoint. 
Immediate fix needed. Affects all users.

Assign to @senior"
```

The agent creates #60 in **To Do** (not **Planning**, because it's a hotfix) and assigns to **senior developer**:

```
⚡ Sending DEV (senior) for #60: Fix critical SQL injection vulnerability
```

#### Step 2: Senior Developer Moves Fast

The senior developer creates a hotfix branch, applies the fix, opens a PR, and posts updates:

```
✅ DEV DONE #60 — SQL injection patched. PR #999 opened for expedited review.
```

#### Step 3: Expedited Review

The reviewer sees it's a hotfix and prioritizes:

```
⚠️  URGENT: Checking PR #999 for #60...
🔀 PR approved for #60 — auto-merged. Issue closed. Deployed to production.
```

---

### Scenario 3: Refactoring Large Module (Multiple Developers)

You want to refactor a large module across multiple files. This requires coordination.

#### Step 1: Create Epic/Parent Issue

```
"Create an issue: Refactor: Extract API layer into separate service

Description:
## Goal
Move API logic from monolith into a separate microservice.

## Scope
- Controllers: `src/controllers/*.ts` → `api-service/src/*.ts`
- Models: `src/models/*.ts` → `api-service/src/models/*.ts`
- Tests: Update all references

## Constraints
- Must maintain backward compatibility
- API contract must not change during transition

## Phases
1. Extract interfaces & models (junior, ~4h)
2. Move controllers (medior, ~8h)  
3. Update tests & mocks (junior, ~6h)
4. Integration testing (medior, ~4h)
5. Documentation (junior, ~2h)"
```

The agent creates #70 in **Planning**.

#### Step 2: Approve & Break into Tasks

You review and create sub-tasks:

```
"Create issues for the refactoring phases:
1. Extract interfaces & models from API layer (#71)
2. Move controllers to api-service (#72)
3. Update tests and mocks (#73)
4. Integration tests for new service (#74)
5. Update API documentation (#75)"
```

#### Step 3: Move to Queue (Parallel Execution)

```
"Move #71, #72, #73, #74, #75 to To Do"
```

The orchestrator dispatches in parallel:

```
⚡ Sending DEV (junior) for #71: Extract interfaces & models
⚡ Sending DEV (medior) for #72: Move controllers to api-service
⚡ Sending DEV (junior) for #73: Update tests and mocks
```

Tasks can be worked on in parallel. If #72 needs #71 to be done first, the developer can be blocked:

```
Developer comment on #72: "Blocked: waiting for #71 to be completed"
Agent: "⏸️  #72 is blocked. Will retry after #71 is done."
```

Once #71 is merged and closed, the orchestrator automatically unblocks #72:

```
✅ DEV DONE #71 — Interfaces extracted. PR merged.
⚡ Sending DEV (medior) for #72: Move controllers to api-service (unblocked)
```

---

## Multi-Project Management

### Running 3+ Projects in Parallel

You have separate Telegram/WhatsApp groups for each project. The orchestrator manages all of them:

```
── Group: "Dev - API" (project slug: api) ───────────────
Agent: ⚡ Sending DEV (medior) for #12: Add rate limiting
Agent: ✅ DEV DONE #12 — PR opened for review
Agent: 🔀 PR approved for #12 — auto-merged. Issue closed.

── Group: "Dev - Web" (project slug: web) ────────────────
Agent: ⚡ Sending DEV (junior) for #8: Fix mobile layout
Agent: ✅ DEV DONE #8 — CSS media queries added. PR opened.

── Group: "Dev - CLI" (project slug: cli) ────────────────
Agent: ⚡ Sending DEV (medior) for #5: Implement SSH key auth
Agent: ⚡ Sending TESTER for #3: Integration test suite
```

Each project has:
- Separate queue management
- Independent git repositories
- Its own developer pool (via worker sessions)
- Isolated workflow state (Planning → To Do → etc.)

### Coordinating Across Projects

If Project A depends on Project B:

```
[In "Dev - ProjectB" group]
"Create an issue: Add public API endpoint for user data export.
After this is merged, ProjectA can consume it.
See github.com/.../#201 for context."

[In "Dev - ProjectA" group]
"Block #201 on ProjectB's #999"

Agent: "⏸️  #201 is blocked (waiting for external issue)."
```

Once ProjectB's PR is merged:

```
[In "Dev - ProjectB" group]
Agent: "✅ DEV DONE #999 — User export API added. PR merged."

[In "Dev - ProjectA" group]
Agent: "⚡ Sending DEV for #201 (unblocked from ProjectB #999)"
```

---

## Configuration & Customization

### Adjusting Worker Levels Per Project

By default, the orchestrator auto-assigns levels based on complexity:
- **junior** — Simple bugs, documentation, formatting
- **medior** — Standard features, refactoring
- **senior** — Architecture, critical fixes, complex bugs

Override for a specific issue:

```
"Escalate #42 to @senior"
```

The agent updates the label and re-dispatches:

```
Agent: Updated #42 label to Doing/senior
Agent: ⚡ Sending DEV (senior) for #42
```

### Changing Review Policy

By default, all PRs require approval. To skip review for junior tasks:

**In your project configuration (docs/WORKFLOW.md or workspace config):**

```yaml
review_policy:
  junior: "auto-merge"      # Auto-merge without approval
  medior: "manual"          # Require manual approval
  senior: "dual_review"     # Require 2 reviewers
```

### Custom Prompts by Role

Customize how developers approach tasks. In your workspace:

`devclaw/projects/<project>/prompts/developer.md`

```markdown
# Developer Instructions for My Project

## Code Style
- Use TypeScript strict mode
- 2-space indents
- Prefer functional over imperative

## Testing
- Write tests in Jest
- Aim for >80% coverage
- Include edge cases (null, empty arrays, etc.)

## Git Workflow
- Use feature branches
- Rebase before opening PR
- Squash commits with semantic messages
```

---

## Best Practices

### 1. Clear Issue Titles & Descriptions

❌ **Bad:**
```
"Fix stuff"
```

✅ **Good:**
```
"Fix: CORS headers not set on /api/auth endpoint. Causes 403 on client"
```

The better the issue, the faster the developer can work.

### 2. Break Large Tasks into Smaller Ones

❌ **Bad:**
```
"Refactor entire authentication system" (50+ files)
```

✅ **Good:**
```
1. Extract JWT validation logic
2. Create AuthService interface
3. Implement mock provider for tests
4. Update existing code to use new interface
5. Add integration tests
```

Smaller tasks = faster feedback, easier testing, lower risk.

### 3. Use Labels for Context

Add GitHub/GitLab labels to give developers quick context:
- `bug` — Something broken
- `enhancement` — New feature
- `docs` — Documentation only
- `security` — Security issue
- `urgent` — Needs ASAP
- `blocked-on-<issue>` — This task waits for another

DevClaw respects these and adjusts urgency/assignment.

### 4. Escalate Early if Stuck

Don't wait for a junior to struggle for hours. If an issue looks complex:

```
"Create issue: [Task], assign to @senior"
```

Or mid-task:

```
"Escalate #42 to @senior"
```

### 5. Review Feedback Cycle

When a reviewer requests changes, be specific:

```
Developer: "✅ DEV DONE #42"

Reviewer comment: 
"Changes requested:
1. Line 45: Use const instead of let
2. Add TypeScript interface for options param
3. Improve test case coverage (currently 72%)
4. Add JSDoc comment to exported function"
```

The developer sees all feedback in one place and handles it in the next iteration.

### 6. Use Blocked State for Dependencies

```
"Block #45 on #44"
```

The developer can't start #45 until #44 is done. The orchestrator monitors and unblocks automatically.

### 7. Archive Old Issues Regularly

Once done/closed, move old issues to GitHub/GitLab archive. Keep the active queue lean.

---

## Troubleshooting

### "Developer is taking too long"

If a task seems stuck:

```
"Show progress on #42"

Agent: Fetches comments on #42, shows what dev posted.
```

If truly blocked:

```
"Check health"

Agent: Reports on active sessions, stuck tasks, etc.
```

If dev went silent:

```
"Kill session for #42"

Agent: Terminates the session, moves issue back to To Do for reassignment.
```

### "PR conflicts with main branch"

The developer handles this automatically by rebasing:

```
Developer comment: "Rebasing on latest main..."
```

If rebase has conflicts, the dev posts:

```
Developer: "Merge conflict in auth.ts. Manual intervention needed.
  Posting PR for your review."
```

Review the PR to see conflict markers and approve the resolution.

### "Reviewer is inactive"

If a PR is pending review for hours:

```
"Assign @another_reviewer to PR #999"
```

Or escalate:

```
"Escalate review for #42 to @senior"
```

### "Multiple developers merged breaking changes"

This is rare because:
1. Each dev works in a separate worktree
2. PRs are reviewed before merge
3. Tests run automatically

If it happens, the orchestrator can:
1. Revert the bad commit
2. Create a hotfix task
3. Reassign to a senior developer

```
"Create hotfix: Revert PR #999, add regression tests"
```

---

## Performance Tips

### 1. Pre-Write Test Cases

Include test expectations in the issue:

```
## Acceptance Criteria
- User can login with email/password
- Invalid password shows error message
- Session persists across page reload
- Logout clears session
```

Dev writes tests that match these criteria.

### 2. Provide Code Examples

If there's an existing pattern:

```
## Reference Implementation
See `src/auth/login.ts` for similar endpoint.
Follow the same error handling structure.
```

### 3. Link Related Issues & PRs

Help the dev understand context:

```
## Related
- #40: Added OAuth provider support
- #41: Updated user model schema
- Related PR: #900 (in another project)
```

### 4. Isolate API Changes

If your issue involves API changes, mention them upfront:

```
## API Changes
POST /api/users
  New field: `timezone` (optional, string, ISO timezone)
```

The reviewer will check API compatibility.

---

## Advanced: Custom Workflows

You can customize the workflow pipeline in `devclaw/workflow.yaml`:

```yaml
states:
  - name: Planning
    next: To Do, To Research
  - name: To Do
    next: Doing, Blocked
  - name: Doing
    next: To Review, Blocked
  - name: To Review
    next: Reviewing, Doing
  - name: Reviewing
    next: Done, Doing
  - name: Done
    terminal: true
  - name: To Research
    next: Planning, Done
  - name: Blocked
    next: To Do
```

You can add custom states (e.g., `Staging`, `Ready to Deploy`, etc.) for your workflow.

---

## What's Next?

- **Full Agents Guide** → [AGENTS.md](AGENTS.md)
- **Workflow States & Rules** → [docs/WORKFLOW.md](docs/WORKFLOW.md)
- **All Tools** → [docs/TOOLS.md](docs/TOOLS.md)
- **Architecture Details** → [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **FAQ** → [docs/FAQ.md](docs/FAQ.md)

---

**Questions?** Feel free to ask your agent in chat, or file an issue!

Happy shipping! 🚀
