# Forum Topics: Real-Time Worker Session Streaming

Each DevClaw worker gets its own **Telegram forum topic** with real-time streaming of tool calls, code changes, and decisions. The General topic stays clean with orchestrator summaries only.

## How it works

When a worker is dispatched in a **Telegram forum supergroup**:

1. **Topic creation** — DevClaw creates a topic named `{ROLE} {Name} #{issueId}` (e.g. `DEV Cordelia #42`) via the Telegram Bot API
2. **Verbose streaming** — Worker session gets `verboseLevel: "on"`, streaming all tool output to the topic
3. **Message routing** — Agent output is delivered directly to the forum topic via `threadId`
4. **Topic reuse** — Thread ID is cached on the worker slot for feedback cycles

```
Telegram Group (Forum Supergroup)
├── General                          ← orchestrator summaries only
│   ├── 🚀 Started DEV Cordelia (medior) on #42
│   └── ✅ DEV Cordelia DONE #42 — PR opened for review
│
├── DEV Cordelia #42                 ← real-time worker stream
│   ├── Reading issue #42...
│   ├── Creating worktree, implementing changes...
│   ├── Running tests — all passing ✓
│   └── Creating PR...
│
└── TESTER Aurora #42                ← separate worker stream
    ├── Checking OAuth flow...
    └── All checks passed ✓
```

## Backwards compatibility

- **Non-forum groups** work exactly as before — topic creation is skipped
- **Fallback on error** — if topic creation fails, dispatch continues normally (output goes to General)
- **No breaking changes** — feature auto-activates only for forum supergroups

## Configuration

No configuration needed. DevClaw detects forum supergroups automatically and creates topics at dispatch time.

The bot needs **Manage Topics** permission in the Telegram group.

### Optional agent-level config

For richer streaming, set these in `openclaw.json`:

```json5
{
  agents: {
    devclaw: {
      blockStreamingDefault: "on",
      blockStreamingBreak: "text_end",
    }
  }
}
```

This sends each text block as a separate message to the topic, giving real-time visibility into each step.

## Implementation

- `SlotState.threadId` — stores the forum topic thread ID per worker slot
- `Project.isForum` — cached forum detection flag (optimistic, updated on first error)
- `createWorkerTopic()` — creates a topic via Telegram Bot API (`createForumTopicTelegram`), returns threadId
- `sendToAgent()` — routes output to the forum topic when threadId is available
- `ensureSessionFireAndForget()` — sets `verboseLevel: "on"` for worker sessions

## Known limitations

1. **Topic ordering** — with `blockStreamingBreak: "text_end"`, final summaries may appear mid-thread if thinking is enabled
2. **Topics stay open** — by design, for reference and feedback cycles
3. **Forum detection** — optimistic on first run; caches `isForum=false` after first creation failure on non-forum groups
