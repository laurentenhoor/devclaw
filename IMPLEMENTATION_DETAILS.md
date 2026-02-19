# Implementation Details: Context Overflow Auto-Healing (Issue #294)

## Architecture

### Flow Diagram
```
┌─ Every 60 seconds ─────────────────────────────┐
│  Heartbeat Service                              │
│  └─ performHealthPass() for each project       │
│     └─ checkWorkerHealth() for each role       │
│        └─ [NEW] Case 1c: Check abortedLastRun │
│           │                                     │
│           ├─ Found: session.abortedLastRun=true│
│           │  │                                  │
│           │  ├─ Revert issue label            │
│           │  ├─ Clear session key             │
│           │  ├─ Deactivate worker             │
│           │  ├─ Log healing event             │
│           │  └─ Return to queue ✓             │
│           │                                     │
│           └─ Not found: continue to Case 3    │
│              (staleness check)                  │
│                                                 │
└──────────────────────────────────────────────┘
```

### Data Flow

#### Before Healing (Problem State)
```
projects.json:
  devclaw.workers.developer:
    active: true
    issueId: "42"
    level: "senior"
    sessions: { "senior": "agent:xxx:subagent:..." }
    
GitHub:
  Issue #42: label = "Doing"
  
Gateway:
  Session "agent:xxx:subagent:...":
    abortedLastRun: true
    percentUsed: 95%
    
Result: Queue stalled ✗
```

#### After Healing (Solution State)
```
projects.json:
  devclaw.workers.developer:
    active: false          ← deactivated
    issueId: null         ← cleared
    level: null           ← cleared
    sessions: { "senior": null }  ← cleared
    
GitHub:
  Issue #42: label = "To Do"  ← reverted
  
Gateway:
  Session "agent:xxx:subagent:...":
    abortedLastRun: true  ← still marked (historical)
    (no new work assigned)
    
Audit Log:
  type: "context_overflow_healed"
  timestamp: "2026-02-19T12:00:00Z"
  issueId: "42"
  role: "developer"
  
Result: Queue unstalled ✓
```

## Code Changes

### 1. lib/services/health.ts

#### Import Addition
```typescript
import { log as auditLog } from "../audit.js";
```
- Needed to log healing events for monitoring/correlation

#### Detection Matrix Update (Comments)
- Added `abortedLastRun: true` row to show immediate healing action
- Clarified that abortedLastRun indicates context limit (#287, #290)

#### HealthIssue Type Extension
```typescript
| "context_overflow"  // New type for context overflow detection
```

#### New Detection Case (Case 1c)
Inserted between session-dead check (Case 1b) and staleness check (Case 3):

**Location**: After checking if session exists, before checking staleness

**Logic**:
```
IF worker.active AND sessionKey exists AND sessions found (not null)
  ├─ Check if session is alive (exists in gateway)
  │  └─ IF NOT alive: continue to Case 1b (already handled)
  │
  └─ IF alive: Check for abortedLastRun flag
     ├─ IF abortedLastRun: Trigger healing (Case 1c)
     │  ├─ Create HealthFix issue of type "context_overflow"
     │  ├─ If autoFix:
     │  │  ├─ Revert issue label (Doing → To Do, Testing → To Improve)
     │  │  ├─ Clear session key (force fresh start)
     │  │  ├─ Deactivate worker (active = false)
     │  │  └─ Log healing event for monitoring
     │  ├─ Mark fix as "fixed: true"
     │  └─ Return immediately (critical issue, no further checks)
     │
     └─ ELSE: Continue to Case 3 (staleness check)
```

**Key Design Decision**: Return immediately after healing
- Context overflow is a critical issue that must be handled first
- No point checking staleness on a worker we just deactivated
- Prevents cascading checks that might overwrite healing actions

### 2. Integration with Heartbeat

**No changes needed** to heartbeat.ts:
- Existing `checkWorkerHealth()` call with `autoFix: true` runs the healing
- Healed workers counted in `totalHealthFixes` metric
- Audit log automatically captured by `auditLog()` call
- Heartbeat tick summary includes healed count

## Healing Logic Details

### Issue Label Reversion

The healing correctly handles different role → label mappings:

```
Developer workflow:
  Doing → To Do  (back to normal queue)
  
Tester workflow (if enabled):
  Testing → To Improve  (revert to improvement queue)
  
Architect (if applicable):
  N/A (architects are tool-triggered, not queued)
```

Implemented via:
```typescript
const queueLabel = worker.previousLabel ?? getRevertLabel(workflow, role);
await provider.transitionLabel(issueId, activeLabel, queueLabel);
```

- Uses `previousLabel` if available (knows exact queue it came from)
- Falls back to standard revert label (To Do / To Improve)
- Atomic operation via provider.transitionLabel()

### Session Clearing

```typescript
await deactivate(true);  // clearSessions = true
```

In the `deactivate()` helper:
```typescript
if (clearSessions && worker.level) {
  updates.sessions = { ...worker.sessions, [worker.level]: null };
}
```

**Why clear instead of preserve?**
- Session hit context limit → likely accumulated bad state
- Force fresh session on next dispatch ensures clean start
- Acceptable cost: lose reusable context from previous issues
- Gain: recovery from context overflow

### Audit Logging

```typescript
await auditLog(workspaceDir, "context_overflow_healed", {
  project: project.name,
  projectSlug,
  role,
  issueId: worker.issueId,
  sessionKey,
  level: worker.level,
}).catch(() => {});
```

**Log Schema**:
```json
{
  "type": "context_overflow_healed",
  "timestamp": "ISO-8601",
  "payload": {
    "project": "devclaw",
    "projectSlug": "devclaw",
    "role": "developer",
    "issueId": "42",
    "sessionKey": "agent:xxx:subagent:devclaw-developer-senior",
    "level": "senior"
  }
}
```

**Monitoring Use Cases**:
- Count healed workers per hour/day (healing frequency)
- Find issues that heal multiple times (context problems)
- Correlate with context overflow prevention (issue #291)
- Alert on high healing frequency (system needs intervention)

### Error Handling

```typescript
await auditLog(...).catch(() => {});  // Audit failure doesn't block healing
if (issue && currentLabel === expectedLabel) { ... }  // Guard against missing issue
if (autoFix) { ... }  // Only heal if explicitly requested
```

**Design Philosophy**: Healing should not fail the whole health check
- Audit log failure is non-critical
- Issue/label fetch can fail (issue deleted) — handled gracefully
- autoFix flag allows manual healing without side effects

## Testing Strategy

### Unit Tests

1. **Session without abortedLastRun**
   - Input: active worker, healthy session
   - Expected: Skip Case 1c, continue to staleness check
   
2. **Session with abortedLastRun=true**
   - Input: active worker, session alive, abortedLastRun=true
   - Expected: Detect context_overflow, heal if autoFix=true

3. **Healing reverts correct label**
   - For developer: Doing → To Do ✓
   - For tester: Testing → To Improve ✓
   - Respects previousLabel if set

4. **Session cleared on healing**
   - Input: worker.sessions[level] = "key123"
   - After healing: worker.sessions[level] = null
   
5. **Worker deactivated on healing**
   - Input: active = true
   - After healing: active = false, issueId = null

6. **Audit log created**
   - Input: healing occurs with autoFix=true
   - Expected: context_overflow_healed log entry

7. **No healing when autoFix=false**
   - Input: detect overflow but autoFix=false
   - Expected: Issue returned in fixes array, fixed=false

### Integration Tests

1. **Heartbeat detects and heals**
   - Simulate abortedLastRun on live gateway session
   - Run heartbeat tick
   - Verify issue reverted, worker deactivated

2. **Healed issue can be re-dispatched**
   - Heal an issue
   - Run next heartbeat tick
   - Verify issue picked up by fresh worker

3. **Multiple overflows same tick**
   - Create abortedLastRun on 2+ workers
   - Run single health pass
   - Verify all healed in one tick

4. **Grace period respected**
   - Create new worker (startTime = now)
   - Set abortedLastRun=true
   - Run health check immediately
   - Expected: NOT healed (within grace period)
   - After grace period: healed normally

### Monitoring Tests

1. **Metrics captured**
   - Check that healed count increments in healthFixes
   - Verify audit log entries created

2. **High frequency alerts**
   - Simulate same issue healed 3+ times
   - Verify audit logs can be queried for correlation

## Performance Impact

### Time Complexity
- Per worker: O(1) → just checking a boolean flag
- Per project: O(R) where R = number of roles
- Per tick: O(P * R) where P = projects, R = roles
- Already part of health check — no new iteration

### Space Complexity
- One additional check per worker per tick
- No new data structures (reuses existing session lookup)

### Gateway Query Impact
- Session lookup already happens (fetchGatewaySessions)
- Only adds boolean field check on already-fetched data
- Zero additional network calls

### Healing Operations
- transitionLabel: 2 gh calls (add label, remove old)
- updateWorker: atomic file write
- auditLog: append to log file
- Total: ~10-20ms per healing action
- Acceptable latency (runs every 60 seconds)

## Configuration & Tuning

### Grace Period (5 minutes)
```
src/lib/services/health.ts:
  GRACE_PERIOD_MS = 5 * 60 * 1_000
```

Prevents false positives for:
- Freshly dispatched workers (may not appear in gateway yet)
- Workers still initializing (before first message received)

Can be increased if seeing premature healing of new workers.

### Healing Frequency (60 seconds)
```
openclaw.json:
  plugins.entries.devclaw.config.work_heartbeat.intervalSeconds
```

Default: 60s
- Fast enough to unstall queues quickly
- Slow enough to avoid excessive checks
- Tunable per deployment needs

### Auto-Fix Behavior
```
Always enabled in heartbeat (autoFix: true)
Can be disabled per call if needed (e.g., dry-run)
```

## Troubleshooting

### Issue Still Marked as Active After Health Check
- Check: Did health check actually run? (check logs)
- Check: Was autoFix=true? (should be in heartbeat)
- Check: Is session truly alive in gateway? (may be timing issue)
- Check: Is the session key correct? (typo in worker state?)

### Issue Not Reverted to Queue
- Check: Does issue still exist? (if deleted, revert skipped)
- Check: Is issue currently in active label? (must match expectedLabel)
- Check: Did provider.transitionLabel fail? (check audit logs)

### Audit Log Not Created
- Audit logging is best-effort (errors ignored)
- Check audit log file permissions
- Verify workspaceDir is correct
- Logs are appended, not created (must exist)

### Multiple Healings of Same Issue
- Indicates issue keeps hitting context overflow
- This is normal for very complex issues
- Suggests need for #291 (context budget) or issue refactoring
- Monitor via audit logs: look for high healing frequency

## Related Issues

### #287: Original Detection Problem
- Issue: Health check didn't detect abortedLastRun flag
- Solution: This feature adds that detection

### #290: Missing Tool Results
- Issue: Tool call failures don't return results, waste context
- Related: Can cause context overflows that trigger this healing

### #291: Prevention Strategy
- Issue: Prevent context overflows from happening
- Planned: Context budget limits on workers
- Current #294: This is the reactive healing while #291 is developed
- Timeline: #294 is temporary, #291 is the real solution

### #283: Label Loss Prevention
- Issue: Labels lost during failed state transitions
- Complementary: Both features prevent/detect queue stalls
- #283: Prevents label loss itself
- #294: Handles context overflow consequences

## Future Improvements

1. **Partial State Recovery** (#291)
   - Save worker context before overflow
   - Restore on next dispatch attempt
   - Requires session persistence (major change)

2. **Predictive Prevention** (#291)
   - Monitor context% and slow down new dispatches
   - Kill workers proactively before overflow
   - More complex but prevents healing from being needed

3. **Per-Issue Healing Strategy**
   - Some issues might want retry with different level
   - Some might want manual review before retry
   - Needs UI for operator choice

4. **Healing Notifications**
   - Send message to project channel when healing happens
   - Alert operators to recurring issues
   - Requires integration with notify system

5. **Context Metrics Dashboard**
   - Real-time context% for active workers
   - Historical overflow frequency
   - Correlation with issue complexity
