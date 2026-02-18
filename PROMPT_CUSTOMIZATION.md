# Prompt Customization Guide

DevClaw supports per-project, per-role prompt files that let you tailor worker instructions to your project's specific standards and conventions.

## How It Works

When a worker session starts, DevClaw injects role instructions from the workspace. The resolution order is:

1. **Project-specific:** `devclaw/projects/<project-name>/prompts/<role>.md` ← checked first
2. **Workspace default:** `devclaw/prompts/<role>.md` ← fallback

The first file found is used. Project-specific prompts **completely replace** (not merge with) the workspace default.

## Quick Start

When you run `project_register`, DevClaw scaffolds a `developer.md` in your project's prompts directory:

```
devclaw/projects/<your-project>/prompts/developer.md
```

This file is pre-populated with the default instructions. Open it and add your project-specific standards at the bottom under `## Project-Specific Standards`.

## File Locations

```
~/.openclaw/workspace-devclaw/           ← your workspace root
  devclaw/
    prompts/
      developer.md                       ← workspace default (all projects)
      tester.md
      reviewer.md
      architect.md
    projects/
      my-webapp/
        prompts/
          developer.md                   ← project override for my-webapp
      my-api/
        prompts/
          developer.md                   ← project override for my-api
```

## What to Customize

The `## Project-Specific Standards` section in `developer.md` is where you add your project's rules. Key areas:

### Code Style
Linting and formatting tools, style guides, editor config:
```markdown
### Code Style
- Run `npm run lint` before committing (ESLint + Prettier)
- TypeScript strict mode is enabled — no `any` without justification
- Import order: external → internal → relative
```

### Testing Requirements
Test frameworks, coverage minimums, what must be tested:
```markdown
### Testing Requirements
- Run `npm test` before submitting PR
- New utility functions must have unit tests in `__tests__/`
- Min coverage: 80% for new files (enforced by CI)
- Use `describe`/`it` with clear test names
```

### Commit Conventions
Message format, co-author requirements, issue references:
```markdown
### Commit Conventions
- Conventional commits: `feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `docs:`
- Include issue number: `feat: add login page (#42)`
- Branch naming: `feature/<id>-<slug>` or `fix/<id>-<slug>`
```

### Documentation
README updates, inline docs, API docs:
```markdown
### Documentation
- Update README.md if adding new configuration options
- Public functions must have JSDoc comments
- Add entries to CHANGELOG.md under "Unreleased"
```

### Build & Verification
How to build and verify the project compiles/runs:
```markdown
### Build & Verification
- Run `npm run build` after changes to verify TypeScript compiles
- Run `npm run check` for type-only check (faster)
- Restart service: `openclaw gateway restart` after plugin changes
```

---

## Examples by Tech Stack

### TypeScript / Node.js

```markdown
## Project-Specific Standards

### Code Style
- TypeScript strict mode off, but no implicit `any` in new code
- Run `npm run check` to verify types before committing
- Use named exports over default exports

### Testing
- Run `npm test` (vitest) — all tests must pass
- New utility functions need unit tests

### Commit Conventions
- Conventional commits with issue number: `feat: add auth (#12)`
- Branch: `feat/<id>-<slug>` or `fix/<id>-<slug>`

### Build
- `npm run build` to compile TypeScript
- Verify with `npm run check` (tsc --noEmit) — faster type check
```

### Go Backend

```markdown
## Project-Specific Standards

### Code Style
- Run `go fmt ./...` before committing
- Run `go vet ./...` — zero warnings allowed
- Follow standard Go package naming (lowercase, no underscores)

### Testing
- Run `go test ./...` — all tests must pass
- Table-driven tests for functions with multiple cases
- Benchmarks required for performance-critical functions

### Commit Conventions
- Conventional commits: `feat: add rate limiter (#7)`
- PR description must include: what changed, why, and testing done

### Build
- `go build ./...` must succeed
- Check for race conditions on concurrent code: `go test -race ./...`
```

### Python / Data Science

```markdown
## Project-Specific Standards

### Code Style
- Run `ruff check .` and `ruff format .` before committing
- Type hints required for all public functions (enforced by mypy)
- Max line length: 100 characters

### Testing
- Run `pytest` — all tests must pass
- New data processing functions need unit tests with fixture data
- Test notebooks with `nbmake` if modifying `.ipynb` files

### Commit Conventions
- Conventional commits: `feat: add feature extraction pipeline (#5)`
- Include model version in commit if changing ML components

### Build & Environment
- `pip install -e ".[dev]"` to set up dev environment
- `mypy src/` for type checking
- Never commit `.env` files or model weights
```

### Monorepo (npm workspaces / Turborepo)

```markdown
## Project-Specific Standards

### Code Style
- Run linting from workspace root: `npx turbo lint`
- Each package has its own tsconfig — don't cross boundaries

### Testing
- Run from root: `npx turbo test` (runs all affected packages)
- For a single package: `cd packages/my-pkg && npm test`
- Integration tests live in `apps/*/tests/`

### Commit Conventions
- Conventional commits with scope: `feat(api): add endpoint (#15)`
- Scope = package name (e.g., `api`, `web`, `shared`)

### Build
- `npx turbo build` from root
- Check affected packages only: `npx turbo build --filter=...[HEAD^1]`
- Never import across workspace packages without declaring the dependency
```

---

## Tips

- **Start small.** Add the most important rules first (linting, testing). You can always add more later.
- **Be specific.** "Run `npm run lint`" is better than "follow code style".
- **Include commands.** Developers should be able to copy-paste commands directly.
- **Update as the project evolves.** When you add a new tool or standard, update the prompt.
- **Project-specific > global.** If a project has unusual requirements, put them in the project file. Keep the global default minimal.

## Related

- `devclaw/prompts/developer.md` — Edit this to change the default for all projects
- `project_register` tool — Scaffolds prompt files on new project registration
- `AGENTS.md` in your repo — Documents project conventions for both humans and agents
