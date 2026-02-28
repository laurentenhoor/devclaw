# DevClaw — Agent Instructions

DevClaw is an OpenClaw plugin for multi-project dev/qa pipeline orchestration with GitHub/GitLab integration, developer tiers, and audit logging.

## Project Structure

- `index.ts` — Plugin entry point, registers 23 tools, CLI, services, and hooks
- `lib/context.ts` — `PluginContext` DI container (created once in `register()`, threaded everywhere)
- `lib/dispatch/` — Task dispatch logic, bootstrap hook, attachment hook, notifications
- `lib/providers/` — GitHub and GitLab issue providers (via `gh`/`glab` CLI)
- `lib/services/heartbeat/` — Heartbeat service (health, review, queue passes)
- `lib/services/` — Pipeline (completion rules), tick (queue scan), queue
- `lib/setup/` — Agent creation, workspace management, CLI, version tracking
- `lib/tools/tasks/` — Task lifecycle and management tools
- `lib/tools/admin/` — Project admin, channel management, config, setup tools
- `lib/tools/worker/` — Worker-side tools (work_finish)
- `lib/workflow/` — State machine types, defaults, labels, queries
- `lib/projects/` — Project state (projects.json) I/O, mutations, slots
- `lib/config/` — Three-layer config resolution with Zod validation
- `lib/roles/` — Role registry, model selection, level resolution

## Coding Style

- **Separation of concerns** — Each module, function, and class should have a single, clear responsibility. Don't mix I/O with business logic, or UI with data processing.
- **Keep functions small and focused** — If a function does more than one thing, split it up.
- **Meaningful names** — Variables, functions, and files should clearly describe their purpose. Avoid abbreviations unless they're universally understood.
- **No dead code** — Remove unused imports, variables, and unreachable code paths.
- **Favor readability over cleverness** — Straightforward code beats compact one-liners. The next reader (human or agent) should understand the intent without re-reading.

## Conventions

- Never import `child_process` directly — the OpenClaw security scanner flags it. Use `runCommand` from `PluginContext` (`lib/context.ts`), which wraps `api.runtime.system.runCommandWithTimeout`.
- Functions that call `runCommand()` must be async.

## Testing Changes

```bash
npm run build && openclaw gateway restart
```

Wait 3 seconds, then check logs:

```bash
openclaw logs
```

Expect: `[plugins] DevClaw plugin registered (23 tools, 1 CLI command group, 1 service, 3 hooks)`
