# DevClaw — Agent Instructions

DevClaw is an OpenClaw plugin for multi-project dev/qa pipeline orchestration with GitHub/GitLab integration, developer tiers, and audit logging.

## Project Structure

- `index.ts` — Plugin entry point, registers all tools/CLI/services
- `lib/run-command.ts` — Safe command execution wrapper (initialized in `register()`)
- `lib/dispatch.ts` — Task dispatch logic (session spawn/reuse, gateway RPC)
- `lib/providers/` — GitHub and GitLab issue providers (via `gh`/`glab` CLI)
- `lib/services/` — Heartbeat, tick (queue scan), pipeline (completion rules)
- `lib/setup/` — Agent creation, model fetching, LLM-powered model selection
- `lib/tools/` — All registered tools (task_start, work_finish, task_create, etc.)

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
