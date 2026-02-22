# DevClaw — Agent Instructions

DevClaw is an OpenClaw plugin for multi-project dev/qa pipeline orchestration with GitHub/GitLab integration, developer tiers, and audit logging.

## Project Structure

- `index.ts` — Plugin entry point, registers all tools/CLI/services
- `lib/run-command.ts` — Safe command execution wrapper (initialized in `register()`)
- `lib/dispatch.ts` — Task dispatch logic (session spawn/reuse, gateway RPC)
- `lib/providers/` — GitHub and GitLab issue providers (via `gh`/`glab` CLI)
- `lib/services/` — Heartbeat, tick (queue scan), pipeline (completion rules)
- `lib/setup/` — Agent creation, model fetching, LLM-powered model selection
- `lib/tools/` — All registered tools (work_start, work_finish, task_create, etc.)

## Defaults Upgrade Strategy

DevClaw defaults (AGENTS.md, workflow.yaml, role prompts, etc.) are externalized in the `defaults/` directory and can be safely upgraded when you update the plugin.

### Two Tools: When to Use Each

#### `upgrade-defaults` — Smart Incremental Updates (Recommended)

Use `upgrade-defaults` for routine plugin updates. It intelligently merges new defaults while preserving your customizations:

```bash
upgrade-defaults --preview    # See what will change
upgrade-defaults --auto       # Apply safe changes
upgrade-defaults --rollback   # Undo if needed
```

**How it works:**
- Tracks default file hashes in `.INSTALLED_DEFAULTS` manifest
- Compares current files to stored hashes to detect customizations
- Updates files you haven't customized
- Skips or prompts for files you have customized
- Enables safe, reversible upgrades

**When to use:**
- ✅ Monthly/weekly updates
- ✅ Bug fix releases
- ✅ New default features you want to adopt
- ✅ Preserving existing customizations

#### `reset_defaults` — Nuclear Option (Use Sparingly)

Use `reset_defaults` **only** for hard resets. It overwrites all defaults:

```bash
reset_defaults                           # Backup and replace all defaults
reset_defaults resetProjectPrompts=true  # Also delete project-level prompt overrides
```

**How it works:**
- Overwrites all workspace docs, workflow states, and role prompts
- Creates `.bak` backups (manual restore required)
- Clears inactive worker sessions
- Warns about project-level customizations

**When to use:**
- ⚠️ Starting completely fresh
- ⚠️ Clearing corrupted state after troubleshooting
- ⚠️ Discarding extensive experimental changes
- ⚠️ **NOT for routine upgrades** — use `upgrade-defaults` instead

### Hash-Based Customization Detection

When you run `upgrade-defaults`, DevClaw:

1. Reads `.INSTALLED_DEFAULTS` manifest (maps file → hash, timestamp)
2. Computes hash of current file
3. Compares to stored default hash
   - **Match** → You haven't customized it → safe to update
   - **Differ** → You customized it → skip or merge intelligently
4. Shows preview of conflicts before applying

Example `.INSTALLED_DEFAULTS`:
```json
{
  "AGENTS.md": { "hash": "abc123...", "timestamp": 1708564800 },
  "devclaw/workflow.yaml": { "hash": "def456...", "timestamp": 1708564800 },
  "devclaw/prompts/developer.md": { "hash": "ghi789...", "timestamp": 1708564800 }
}
```

### Customization Safe

Your customizations are never overwritten without warning:

- **Workspace docs** (AGENTS.md, HEARTBEAT.md, etc.) — Updated only if unchanged
- **Workflow configuration** (devclaw/workflow.yaml) — Preserved if you edited it
- **Role prompts** (devclaw/prompts/*.md) — Skipped if customized
- **Project prompts** (devclaw/projects/<name>/prompts/*.md) — Never touched by `upgrade-defaults`

### Startup Notifications

When new defaults are available, DevClaw notifies you:

```
⚠️ New defaults available for DevClaw
Run: upgrade-defaults --preview
Or: upgrade-defaults --auto (for automatic safe updates)
Or: reset_defaults (for hard reset)
```

This allows you to:
- Check the preview before upgrading
- Decide whether new features are relevant
- Ignore if you're happy with current state
- Upgrade on your schedule

## Coding Style

- **Separation of concerns** — Each module, function, and class should have a single, clear responsibility. Don't mix I/O with business logic, or UI with data processing.
- **Keep functions small and focused** — If a function does more than one thing, split it up.
- **Meaningful names** — Variables, functions, and files should clearly describe their purpose. Avoid abbreviations unless they're universally understood.
- **No dead code** — Remove unused imports, variables, and unreachable code paths.
- **Favor readability over cleverness** — Straightforward code beats compact one-liners. The next reader (human or agent) should understand the intent without re-reading.

## Conventions

- Never import `child_process` directly — the OpenClaw security scanner flags it. Use `runCommand()` from `lib/run-command.ts`, which wraps `api.runtime.system.runCommandWithTimeout`.
- Functions that call `runCommand()` must be async.

## Testing Changes

```bash
npm run build && openclaw gateway restart
```

Wait 3 seconds, then check logs:

```bash
openclaw logs
```

Expect: `[plugins] DevClaw plugin registered (11 tools, 1 CLI command group, 1 service)`
