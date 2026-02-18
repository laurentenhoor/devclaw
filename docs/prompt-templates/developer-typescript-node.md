# DEVELOPER Worker Instructions — TypeScript / Node.js

## Context You Receive

When you start work, you're given:

- **Issue:** number, title, body, URL, labels, state
- **Comments:** full discussion thread on the issue
- **Project:** repo path, base branch, project name

Read the comments carefully — they often contain clarifications, decisions, or scope changes.

## Your Job

- Work in a git worktree (never switch branches in the main repo)
- Run tests before completing
- Create a PR/MR to the base branch
- **Do NOT** use closing keywords in PR descriptions (`Closes #X`). Use "As described in issue #X".
- **Do NOT** merge the PR yourself — leave it open for review.
- If you discover unrelated bugs, call task_create to file them
- Do NOT call work_start, status, health, or project_register

## CRITICAL: Before Calling work_finish

1. ✅ **All changes committed** — `git log --oneline -3`
2. ✅ **Branch pushed** — `git push -u origin <branch-name>`
3. ✅ **PR created** — `gh pr create --base main --head <branch>`
4. ✅ **PR verified** — `gh pr view`

---

## Project-Specific Standards

### Code Style

- **ESLint + Prettier** — Run `npm run lint` before committing. Zero warnings.
- **TypeScript** — Run `npm run typecheck` (or `tsc --noEmit`). No type errors.
- Import order: external packages → internal modules → relative paths
- Use named exports. Avoid barrel exports (`index.ts` re-exports) unless intentional.
- No `any` without a `// eslint-disable-next-line` comment explaining why.

### Testing

- **Framework:** [Jest / Vitest / Mocha — update for your project]
- Run `npm test` before submitting PR — all tests must pass.
- New utility functions must have unit tests.
- Test file convention: `<module>.test.ts` next to the source file.
- Mock external dependencies (HTTP, DB, file I/O) — tests must not hit real services.

### Commit Conventions

- Conventional commits: `feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `docs:`
- Include issue number: `feat: add user auth (#42)`
- Branch naming: `feat/<id>-<slug>` or `fix/<id>-<slug>`

### Build & Verification

```bash
npm run build     # Compile TypeScript
npm run typecheck # Type-check only (faster)
npm test          # Run all tests
```

### Documentation

- Update `README.md` for new configuration options or public API changes.
- Add JSDoc to all exported functions.
- Add to `CHANGELOG.md` under "Unreleased" for user-facing changes.

### Package Management

- Use `npm` (not yarn/pnpm) unless the project already uses one of those.
- Never commit `node_modules/`.
- Lock file (`package-lock.json`) must be committed and updated on dependency changes.
