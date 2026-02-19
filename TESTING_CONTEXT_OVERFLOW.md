# Testing Context Overflow Auto-Healing

## Manual Testing

### Scenario 1: Simulate Context Overflow
```bash
# Start with a healthy system
$ openclaw devclaw health
✓ devclaw: No health issues

# Manually set a worker to active (simulate dispatch)
# Edit ~/.openclaw/workspace-devclaw/devclaw/projects.json:
{
  "projects": {
    "devclaw": {
      "workers": {
        "developer": {
          "active": true,
          "issueId": "42",
          "level": "senior",
          "startTime": "2026-02-19T12:00:00Z",
          "sessions": {
            "senior": "agent:test:subagent:devclaw-developer-senior"
          }
        }
      }
    }
  }
}

# Manually create GitHub issue with active label
$ gh issue create --title "Test issue #42" --label "Doing"
# OR: gh issue edit 42 --add-label "Doing"

# Simulate context overflow in gateway session
# (Manually edit session file or wait for real overflow)
# ~/.openclaw/workspace-devclaw/devclaw/sessions/...
# Add: "abortedLastRun": true

# Run health check with auto-fix
$ openclaw devclaw health fix=true
Checking project: devclaw
  Developer:
    ✓ Detected: context_overflow
      Issue #42: session hit context limit
      Action: Reverted to "To Do", cleared session
      Result: Worker healed ✓

# Verify healing results
$ openclaw devclaw health
✓ devclaw: No health issues

# Verify issue was reverted
$ gh issue view 42 --json labels
labels:
  - "To Do"  ← Reverted from "Doing" ✓

# Verify worker was deactivated
# Edit projects.json:
  "developer": {
    "active": false,      ← Deactivated
    "issueId": null,      ← Cleared
    "level": null,
    "sessions": {
      "senior": null      ← Cleared
    }
  }
```

### Scenario 2: Automatic Healing via Heartbeat
```bash
# Same setup as Scenario 1 (worker active, issue labeled, session aborted)

# Just wait 60 seconds (heartbeat interval)
# Heartbeat service runs automatically:

[12:00:00] Heartbeat tick #42
[12:00:05] Health pass: project 'devclaw'
  Developer role check:
    - Active worker found: #42
    - Session alive: true
    - abortedLastRun: true
    → Healing triggered
    → Issue reverted to "To Do"
    → Worker deactivated
    → Audit logged

[12:00:10] Tick pass: filling free slots
  - Developer slot now free
  - Issue #42 in "To Do" queue
  - Next issue picked up → queue unstalled ✓

# Verify results
$ openclaw devclaw health
✓ devclaw: No health issues (healed automatically)
```

### Scenario 3: Multiple Overflows Same Tick
```bash
# Create multiple active workers with overflows

projects.json:
  "developer": active, session aborted
  "tester": active, session aborted
  (assuming test phase enabled)

# Run health check
$ openclaw devclaw health fix=true
Checking project: devclaw
  Developer:
    ✓ Detected: context_overflow on issue #42
    ✓ Healed: reverted to "To Do"
  
  Tester:
    ✓ Detected: context_overflow on issue #43
    ✓ Healed: reverted to "To Improve"

Results: 2 health fixes applied

# Both workers now free, both issues back in queues
```

### Scenario 4: Grace Period (Not Healing New Workers)
```bash
# Dispatch a new worker (startTime = now)
$ openclaw devclaw work-start 99

# Immediately check health (before grace period expires)
$ openclaw devclaw health

# Even if this worker's session happens to have abortedLastRun:true,
# it should NOT be healed (within 5-minute grace period)

# After grace period expires (5 minutes)
$ openclaw devclaw health
✓ Grace period expired, normal healing would apply
```

## Audit Log Verification

### Check Healing Events
```bash
# View audit log
$ tail -20 ~/.openclaw/workspace-devclaw/devclaw/audit.log

# Look for healing events:
{"type":"context_overflow_healed","timestamp":"2026-02-19T12:00:10Z","payload":{"project":"devclaw","projectSlug":"devclaw","role":"developer","issueId":"42","sessionKey":"agent:xxx:subagent:devclaw-developer-senior","level":"senior"}}

# Query healing events
$ grep "context_overflow_healed" ~/.openclaw/workspace-devclaw/devclaw/audit.log | wc -l
# Result: number of times healing occurred
```

### Monitor Healing Frequency
```bash
# Count healings per hour
$ grep "context_overflow_healed" ~/.openclaw/workspace-devclaw/devclaw/audit.log | \
  jq -r '.timestamp' | \
  cut -d'T' -f1 | \
  uniq -c

# Result shows which dates had most healings
# Helps identify if overflows are increasing/decreasing over time
```

## Automated Test Cases

### Test 1: Detect Context Overflow
```typescript
// Given
const session = { key: "test", abortedLastRun: true };
const worker = { active: true, sessionKey: "test", level: "senior" };
const issue = { labels: ["Doing"] };
const sessions = new Map([["test", session]]);

// When
const fixes = await checkWorkerHealth({
  worker, issue, sessions, autoFix: false
});

// Then
expect(fixes).toHaveLength(1);
expect(fixes[0].issue.type).toBe("context_overflow");
expect(fixes[0].fixed).toBe(false); // Not fixed without autoFix
```

### Test 2: Heal Context Overflow
```typescript
// Given
const session = { key: "test", abortedLastRun: true };
const worker = { active: true, issueId: "42", level: "senior" };
const issue = { labels: ["Doing"] };
const sessions = new Map([["test", session]]);

// Mock providers
const mockProvider = {
  getIssue: () => issue,
  transitionLabel: jest.fn(),
  updateWorker: jest.fn(),
};

// When
const fixes = await checkWorkerHealth({
  worker, issue, sessions, autoFix: true,
  provider: mockProvider
});

// Then
expect(fixes[0].fixed).toBe(true);
expect(mockProvider.transitionLabel).toHaveBeenCalledWith(
  42, "Doing", "To Do"
);
expect(auditLog).toHaveBeenCalledWith("context_overflow_healed", {
  issueId: "42",
  role: "developer",
  level: "senior"
});
```

### Test 3: Respect Grace Period
```typescript
// Given
const newWorker = {
  active: true,
  startTime: new Date(Date.now() - 2 * 60 * 1000).toISOString(), // 2 min ago
};
const session = { abortedLastRun: true };
const sessions = new Map([["test", session]]);
const withinGracePeriod = (Date.now() - new Date(newWorker.startTime)) < GRACE_PERIOD_MS;

// When
const fixes = await checkWorkerHealth({
  worker: newWorker, sessions, autoFix: true
});

// Then
// If withinGracePeriod is true, should NOT heal
if (withinGracePeriod) {
  expect(fixes).toHaveLength(0); // Not detected during grace period
}
```

### Test 4: Multiple Roles
```typescript
// Given 2 projects with multiple roles having overflows

// When
const result = await heartbeat.performHealthPass();

// Then
expect(result.totalHealthFixes).toBe(2); // Both healed
expect(auditLog).toHaveBeenCalledTimes(2);
```

## Monitoring in Production

### Set Up Alerts
```json
// Example: Alert when healing happens frequently
// (This would be in a monitoring service)

{
  "alert": "ContextOverflowHealing",
  "condition": "count(context_overflow_healed) > 3 in last hour",
  "severity": "warning",
  "message": "Multiple context overflows healed in last hour. Consider implementing #291 (context budget prevention).",
  "actions": ["notify_engineering", "create_issue"]
}
```

### Dashboard Metrics
```sql
-- Count healings per project
SELECT project, COUNT(*) as healing_count
FROM audit_logs
WHERE type = 'context_overflow_healed'
  AND timestamp > NOW() - INTERVAL '24 hours'
GROUP BY project
ORDER BY healing_count DESC;

-- Find issues with multiple healings
SELECT issue_id, COUNT(*) as heal_count
FROM audit_logs
WHERE type = 'context_overflow_healed'
  AND timestamp > NOW() - INTERVAL '7 days'
GROUP BY issue_id
HAVING COUNT(*) > 1
ORDER BY heal_count DESC;

-- Show healing timeline
SELECT DATE_TRUNC('hour', timestamp) as hour,
       COUNT(*) as heal_count
FROM audit_logs
WHERE type = 'context_overflow_healed'
  AND timestamp > NOW() - INTERVAL '30 days'
GROUP BY hour
ORDER BY hour DESC;
```

## Visual Walkthrough

### Before Healing
```
┌─ Issue #42 ────────────────────────┐
│ Label: "Doing"                      │
│ Status: STALLED (worker stuck)      │
│                                     │
└─────────────────────────────────────┘
     ↓
┌─ Developer Worker ──────────────────┐
│ Status: ACTIVE                      │
│ IssueId: 42                         │
│ Level: senior                       │
│ Session: agent:xxx:subagent:...    │
│                                     │
└─────────────────────────────────────┘
     ↓
┌─ Gateway Session ───────────────────┐
│ Key: agent:xxx:subagent:...        │
│ Status: ALIVE                       │
│ abortedLastRun: TRUE  ← Problem!    │
│ percentUsed: 95%                    │
│                                     │
└─────────────────────────────────────┘
```

### After Healing (Auto-Applied)
```
┌─ Issue #42 ────────────────────────┐
│ Label: "To Do"  ← Reverted          │
│ Status: QUEUED (ready for dispatch) │
│                                     │
└─────────────────────────────────────┘
     ↓
┌─ Developer Worker ──────────────────┐
│ Status: INACTIVE  ← Deactivated     │
│ IssueId: null     ← Cleared         │
│ Level: null       ← Cleared         │
│ Sessions:                           │
│   senior: null    ← Cleared         │
│                                     │
└─────────────────────────────────────┘
     ↓
┌─ Gateway Session ───────────────────┐
│ Key: agent:xxx:subagent:...        │
│ Status: ALIVE (but not used)        │
│ abortedLastRun: TRUE (historical)   │
│ (no new work assigned)              │
│                                     │
└─────────────────────────────────────┘

Next heartbeat tick:
├─ Issue #42 picked up by fresh worker
├─ New session created
└─ Queue unstalled ✓
```

## Success Criteria

✓ Feature considered successful when:
1. Health check detects `abortedLastRun: true` on active workers
2. Healing automatically reverts issue labels to queue state
3. Worker is deactivated and session is cleared
4. Audit log captures healing event
5. Issue appears in queue ready for re-dispatch
6. Heartbeat applies healing automatically every 60 seconds
7. No operator intervention needed
8. Multiple healings tracked for correlation with #291

## Regression Tests

After deployment, verify:
1. ✓ Healthy workers (no overflows) still function normally
2. ✓ Non-overflowed sessions not affected by new check
3. ✓ Grace period works (new workers within 5min not healed prematurely)
4. ✓ Healing is fast (<50ms per worker)
5. ✓ Audit logs don't fill up disk (reasonable event size)
6. ✓ Multiple projects can have healings in same tick
7. ✓ Manual health check works with and without autoFix
