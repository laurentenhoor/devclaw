# DevClaw — Agent Instructions

DevClaw is an OpenClaw plugin that provides multi-project dev/qa pipeline orchestration with GitHub/GitLab integration, developer tiers, and audit logging.

## Testing Changes

To verify changes against a live gateway, run:

```bash
npm run build && openclaw gateway restart
```

Wait 3 seconds, then check the logs:

```bash
openclaw logs
```

Look for the plugin registration line and any errors:

```
[plugins] DevClaw plugin registered (11 tools, 1 CLI command group, 1 service)
```

## Project Structure

- `index.ts` — Plugin entry point, registers all tools/CLI/services
- `lib/run-command.ts` — Wrapper around `api.runtime.system.runCommandWithTimeout` (initialized in `register()`)
- `lib/dispatch.ts` — Core task dispatch logic (session spawn/reuse, gateway RPC)
- `lib/providers/` — GitHub and GitLab issue providers (via `gh`/`glab` CLI)
- `lib/services/` — Heartbeat, tick (queue scan), pipeline (completion rules)
- `lib/setup/` — Agent creation, model fetching, LLM-powered model selection
- `lib/tools/` — All registered tools (work_start, work_finish, task_create, etc.)

## Key Conventions

- All external command execution uses `runCommand()` from `lib/run-command.ts` — never import `child_process` directly (the OpenClaw plugin security scanner flags it).
- The plugin SDK provides `api.runtime.system.runCommandWithTimeout` which is the sanctioned way to run external commands.
- Functions that call `runCommand()` must be async.
