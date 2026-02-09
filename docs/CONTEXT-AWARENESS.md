# Context-Aware DevClaw

DevClaw now adapts its behavior based on how you interact with it.

## Design Philosophy

**One Group = One Project = One Team**

DevClaw enforces strict boundaries between projects:
- Each Telegram/WhatsApp group represents a **single project**
- Each project has its **own dedicated dev/qa workers**
- Project work happens **inside that project's group**
- Setup and configuration happen **outside project groups**

This design prevents:
- ❌ Cross-project contamination (workers picking up wrong project's tasks)
- ❌ Confusion about which project you're working on
- ❌ Accidental registration of wrong groups
- ❌ Setup discussions cluttering project work channels

This enables:
- ✅ Clear mental model: "This group = this project"
- ✅ Isolated work streams: Each project progresses independently
- ✅ Dedicated teams: Workers focus on one project at a time
- ✅ Clean separation: Setup vs. operational work

## Three Interaction Contexts

### 1. **Via Another Agent** (Setup Mode)
When you talk to your main agent (like Henk) about DevClaw:
- ✅ Use: `devclaw_onboard`, `devclaw_setup`
- ❌ Avoid: `task_pickup`, `queue_status` (operational tools)

**Example:**
```
User → Henk: "Can you help me set up DevClaw?"
Henk → Calls devclaw_onboard
```

### 2. **Direct Message to DevClaw Agent**
When you DM the DevClaw agent directly on Telegram/WhatsApp:
- ✅ Use: `queue_status` (all projects), `session_health` (system overview)
- ❌ Avoid: `task_pickup` (project-specific work), setup tools

**Example:**
```
User → DevClaw DM: "Show me the status of all projects"
DevClaw → Calls queue_status (shows all projects)
```

### 3. **Project Group Chat**
When you message in a Telegram/WhatsApp group bound to a project:
- ✅ Use: `task_pickup`, `task_complete`, `task_create`, `queue_status` (auto-filtered)
- ❌ Avoid: Setup tools, system-wide queries

**Example:**
```
User → OpenClaw Dev Group: "@henk pick up issue #42"
DevClaw → Calls task_pickup (only works in groups)
```

## How It Works

### Context Detection
Each tool automatically detects:
- **Agent ID** - Is this the DevClaw agent or another agent?
- **Message Channel** - Telegram, WhatsApp, or CLI?
- **Session Key** - Is this a group chat or direct message?
  - Format: `agent:{agentId}:{channel}:{type}:{id}`
  - Telegram group: `agent:devclaw:telegram:group:-5266044536`
  - WhatsApp group: `agent:devclaw:whatsapp:group:120363123@g.us`
  - DM: `agent:devclaw:telegram:user:657120585`
- **Project Binding** - Which project is this group bound to?

### Guardrails
Tools include context-aware guidance in their responses:
```json
{
  "contextGuidance": "🛡️ Context: Project Group Chat (telegram)\n
    You're in a Telegram group for project 'openclaw-core'.\n
    Use task_pickup, task_complete for project work.",
  ...
}
```

## Integrated Tools

### ✅ `devclaw_onboard`
- **Works best:** Via another agent or direct DM
- **Blocks:** Group chats (setup shouldn't happen in project groups)

### ✅ `queue_status`
- **Group context:** Auto-filters to that project
- **Direct context:** Shows all projects
- **Via-agent context:** Suggests using devclaw_onboard instead

### ✅ `task_pickup`
- **ONLY works:** In project group chats
- **Blocks:** Direct DMs and setup conversations

### ✅ `project_register`
- **ONLY works:** In the Telegram/WhatsApp group you're registering
- **Blocks:** Direct DMs and via-agent conversations
- **Auto-detects:** Group ID from current chat (projectGroupId parameter now optional)

**Why this matters:**
- **Project Isolation**: Each group = one project = one dedicated team
- **Clear Boundaries**: Forces deliberate project registration from within the project's space
- **Team Clarity**: You're physically in the group when binding it, making the connection explicit
- **No Mistakes**: Impossible to accidentally register the wrong group when you're in it
- **Natural Workflow**: "This group is for Project X" → register Project X here

## Testing

### Debug Tool
Use `context_test` to see what context is detected:
```
# In any context:
context_test

# Returns:
{
  "detectedContext": { "type": "group", "projectName": "openclaw-core" },
  "guardrails": "🛡️ Context: Project Group Chat..."
}
```

### Manual Testing
1. **Setup Mode:** Message your main agent → "Help me configure DevClaw"
2. **Status Check:** DM DevClaw agent (Telegram/WhatsApp) → "Show me the queue"
3. **Project Work:** Post in project group (Telegram/WhatsApp) → "@henk pick up #42"

Each context should trigger different guardrails.

## Configuration

Add to `~/.openclaw/openclaw.json`:
```json
"plugins": {
  "entries": {
    "devclaw": {
      "config": {
        "devClawAgentIds": ["henk-development", "devclaw-test"],
        "models": { ... }
      }
    }
  }
}
```

The `devClawAgentIds` array lists which agents are DevClaw orchestrators.

## Implementation Details

- **Module:** [lib/context-guard.ts](../lib/context-guard.ts)
- **Tests:** [tests/unit/context-guard.test.ts](../tests/unit/context-guard.test.ts) (15 passing)
- **Integrated tools:** 4 key tools (`devclaw_onboard`, `queue_status`, `task_pickup`, `project_register`)
- **Detection logic:** Checks agentId, messageChannel, sessionKey pattern matching

## WhatsApp Support

DevClaw **fully supports WhatsApp** groups with the same architecture as Telegram:

- ✅ WhatsApp group detection via `sessionKey.includes("@g.us")`
- ✅ Projects keyed by WhatsApp group ID (e.g., `"120363123@g.us"`)
- ✅ Context-aware tools work identically for both channels
- ✅ One project = one group (Telegram OR WhatsApp)

**To register a WhatsApp project:**
1. Go to the WhatsApp group chat
2. Call `project_register` from within the group
3. Group ID auto-detected from context

The architecture treats Telegram and WhatsApp identically - the only difference is the group ID format.

## Future Enhancements

- [ ] Integrate into remaining tools (`task_complete`, `session_health`, `task_create`, `devclaw_setup`)
- [ ] System prompt injection (requires OpenClaw core support)
- [ ] Context-based tool filtering (hide irrelevant tools)
- [ ] Per-project context overrides
