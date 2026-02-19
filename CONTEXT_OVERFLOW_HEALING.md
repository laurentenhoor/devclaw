# Context Overflow Auto-Healing — Issue #294

## Overview

This feature automatically detects and heals workers stuck in context overflow state (when OpenClaw marks `abortedLastRun: true` on a session). Without this healing, the worker slot remains occupied indefinitely, blocking the queue.

## Problem

### Root Cause Chain (#287, #290, #294)
1. **#287**: Worker session hits context limit during execution
2. **#290**: Missing tool results cause context staleness
3. **#291**: Prevention strategy (context budget) — future work
4. **#294**: This feature — reactive healing while prevention is developed

### Symptom: Queue Stalls
- Worker marked `active: true` in projects.json
- Session exists in gateway with `abortedLastRun: true`
- Issue has active label (e.g., "Doing" for developers, "Testing" for testers)
- Health check doesn't detect it → worker slot stays occupied
- New issues can't be picked up → queue stalls

### Impact
- Queue throughput drops to zero (only one developer/tester per project)
- Operator must manually intervene to reset worker state
- No visibility into frequency/cause

## Solution: Auto-Healing

### Detection
When health check runs (every 60 seconds by default):
1. Find all active workers
2. For each worker with a session:
   - Query gateway session state
   - Check `session.abortedLastRun` flag
   - If true → trigger healing

### Healing Strategy (Option C: Reset + Requeue)
For each detected context overflow:
1. **Revert issue label**: Move issue from "Doing" → "To Do" (or "Testing" → "To Improve")
2. **Clear session**: Remove the aborted session key from worker state
3. **Deactivate worker**: Mark worker as `active: false`
4. **Log healing**: Audit log entry for monitoring/correlation

Result:
- Worker slot is freed
- Issue appears in queue ready for fresh attempt
- Next heartbeat can dispatch a new worker to it
- Queue unstalls automatically

### Auditing & Monitoring
Each healing triggers:
- Audit log: `context_overflow_healed` event with:
  - project, projectSlug, role
  - issueId (which issue was healed)
  - sessionKey (which session aborted)
  - level (junior/medior/senior)
- Health report: Issue listed as `context_overflow` type with message
- Heartbeat summary: Incremented in `totalHealthFixes` counter

## Code Changes

### lib/services/health.ts
**New Detection (Case 1c)**
```typescript
// After session alive check, before staleness check
if (worker.active && sessionKey && sessions && isSessionAlive(sessionKey, sessions)) {
  const session = sessions.get(sessionKey);
  if (session?.abortedLastRun) {
    // Healing logic: revert label, clear session, deactivate worker
    // Log as audit event for monitoring
  }
}
```

**New HealthIssue Type**
```typescript
type: "context_overflow" // Indicates session hit context limit
```

**Updated Detection Matrix**
- Rows in the matrix now include `abortedLastRun: true` state
- Points to immediate healing action

### lib/services/heartbeat.ts
- No changes needed — existing health check integration automatically runs the detection
- Healed workers counted in `totalHealthFixes` metric

### lib/services/gateway-sessions.ts
- Already provides `abortedLastRun` flag from gateway session state
- No changes needed

## Integration Points

### 1. Automatic Health Check (Heartbeat)
- Runs every 60 seconds (configurable via `work_heartbeat.intervalSeconds`)
- Calls `checkWorkerHealth()` for each role in each project
- Healing happens automatically with `autoFix: true`
- No operator intervention required

### 2. Manual Health Check (CLI)
```bash
openclaw devclaw health fix=true
```
- Runs health check on all projects
- Healing automatically applied with `fix=true`
- Shows which workers were healed in output

### 3. Monitoring & Alerting
Via audit logs and heartbeat metrics:
```json
{
  "type": "context_overflow_healed",
  "project": "devclaw",
  "projectSlug": "devclaw",
  "role": "developer",
  "issueId": "42",
  "sessionKey": "agent:xxx:subagent:devclaw-developer-senior",
  "level": "senior",
  "timestamp": "2026-02-19T12:00:00Z"
}
```

Can be correlated with context overflow prevention efforts (#291).

## Behavior Examples

### Example 1: Happy Path (Auto-Healing)
```
[12:00:00] Heartbeat tick: fetching gateway sessions...
[12:00:05] Health check for project "devclaw", role "developer"
  ✓ Case 1c detected: session abortedLastRun=true
  → Reverting issue #42 from "Doing" to "To Do"
  → Clearing session key for developer level
  → Deactivating worker
  ✓ Healed: developer now free to pick up next issue
[12:00:10] Tick pass: picking up next issue
  ✓ Dispatched #43 to free developer slot
  → Queue unstalled ✓
```

### Example 2: Multiple Overflows (Same Tick)
```
[12:01:00] Health check for project "project1", role "developer"
  ✓ Case 1c: healed #50 (context overflow)
[12:01:05] Health check for project "project2", role "tester"
  ✓ Case 1c: healed #51 (context overflow)
[12:01:10] Tick pass results
  ✓ 2 health fixes, 2 pickups
  → Both projects' queues resumed
```

### Example 3: Manual Intervention (If Needed)
```bash
$ openclaw devclaw health fix=true
Project: devclaw
  Developer:
    ✓ context_overflow detected: #42 (session aborted)
    ✓ Healed: reverted to "To Do", cleared session
    ✓ Worker deactivated, ready for next issue
```

## Configuration

### Heartbeat Frequency
Default: every 60 seconds
```json
{
  "plugins": {
    "entries": {
      "devclaw": {
        "config": {
          "work_heartbeat": {
            "intervalSeconds": 60  // Adjust if needed
          }
        }
      }
    }
  }
}
```

### Grace Period (For New Workers)
Default: 5 minutes
- Newly dispatched workers won't be checked for context overflow in first 5 minutes
- Prevents false positives for workers still initializing
- Can't be configured per-issue (global setting)

## Limitations & Edge Cases

1. **Already Dispatched Work**: If a worker was executing work when context overflow hit, that work is lost
   - Healing moves issue back to queue for retry
   - Worker gets fresh session on next dispatch
   - No partial state preserved

2. **High Frequency Overflows**: If the same issue keeps hitting context overflow
   - Each healing logs an audit event (helps identify problem)
   - Issue goes back to "To Do", gets picked up again, hits limit again
   - This indicates the issue is too complex for available context
   - **Real solution**: #291 (context budget prevention) should reduce frequency

3. **Multiple Levels**: If a worker has multiple session keys (junior + medior)
   - Only the active level's session is cleared
   - Other level sessions remain (will be reused if that level is selected next)

4. **Session Reuse**: Sessions are reused across multiple issues
   - Clearing the session forces a fresh start (good for recovery)
   - But clears useful context from previous issues (minor inefficiency)

## Correlation with #291 (Prevention)

This healing feature is **temporary while #291 is implemented**:
- **#291** (Prevention): Set context budget limits, stop dispatching when near limit
- **#294** (Healing): Auto-recover when context overflow happens
- **#287** (Detection): Original issue—what happens when limit is exceeded

Timeline:
1. ✅ #283 — Prevent label loss (completed)
2. ✅ #294 — Auto-heal context overflows (this feature)
3. ⏳ #291 — Prevent context overflows from happening (future)

Goal: Eventually #291 will reduce overflows so much that #294 healing is rarely needed.

## Testing

### Unit Test Cases
1. ✓ Active worker, session alive, `abortedLastRun: false` → No healing
2. ✓ Active worker, session alive, `abortedLastRun: true` → Healing triggered
3. ✓ Healing reverts correct labels (To Do, To Improve depending on role)
4. ✓ Healing clears session key for the active level
5. ✓ Healing deactivates worker
6. ✓ Audit log created for healed worker
7. ✓ Healing is fast (no blocking operations)

### Integration Test Cases
1. ✓ Heartbeat automatically detects and heals overflows
2. ✓ Healed issue appears in queue for next dispatch
3. ✓ Multiple overflows in same tick heal correctly
4. ✓ Manual `health fix=true` also heals overflows
5. ✓ Grace period prevents premature healing of new workers

### Monitoring Test Cases
1. ✓ Audit logs capture healing events
2. ✓ Heartbeat reports include healed count
3. ✓ Dashboard shows context_overflow issues

## Metrics to Monitor

After deployment, track:
- **Healing frequency** (context_overflow_healed audit events per hour)
- **Issue re-attempts** (same issue healed multiple times)
- **Queue stall duration** (time from overflow to healing)
- **Correlation with context overflow prevention** (reduction over time)

This data informs #291 work and helps identify which issues need architectural changes.

## See Also
- #287 — Original issue: health check didn't detect abortedLastRun
- #290 — Related: missing tool results cause context staleness
- #291 — Prevention: context budget and proactive limiting
- #283 — Label loss prevention (complementary safety feature)
