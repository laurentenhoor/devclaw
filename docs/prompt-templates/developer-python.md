# DEVELOPER Worker Instructions — Python

## Context You Receive

When you start work, you're given:

- **Issue:** number, title, body, URL, labels, state
- **Comments:** full discussion thread on the issue
- **Project:** repo path, base branch, project name

Read the comments carefully — they often contain clarifications, decisions, or scope changes.

## Your Job

- Work in a git worktree (never switch branches in the main repo)
- Run tests before completing
- Create a PR to the base branch
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

- **Ruff** — Run `ruff check . && ruff format --check .` before committing.
- **Type hints** — Required on all public functions. Run `mypy src/` to verify.
- Max line length: 100 characters (configured in `pyproject.toml`).
- Use `pathlib.Path` over `os.path` for file operations.
- No bare `except:` — always catch specific exception types.

### Testing

- **Framework:** pytest
- Run `pytest` before submitting PR — all tests must pass.
- New functions need unit tests in `tests/` mirroring the source structure.
- Use fixtures for shared test data. Avoid test interdependence.
- Mock external services with `pytest-mock` or `responses`.

```bash
pytest                           # Run all tests
pytest tests/unit/               # Run unit tests only
pytest --cov=src --cov-report=term-missing  # With coverage
```

### Commit Conventions

- Conventional commits: `feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `docs:`
- Include issue number: `feat: add data pipeline (#12)`
- Branch naming: `feat/<id>-<slug>` or `fix/<id>-<slug>`

### Build & Verification

```bash
pip install -e ".[dev]"    # Install dev dependencies
ruff check .               # Lint
ruff format --check .      # Format check
mypy src/                  # Type check
pytest                     # Run tests
```

### Environment & Dependencies

- Use `pyproject.toml` (not `setup.py`) for packaging.
- Pin dev dependencies in `pyproject.toml` `[project.optional-dependencies.dev]`.
- Never commit `.env` files, API keys, or model weights.
- Virtual environment: create with `python -m venv .venv` — never commit `.venv/`.

### Documentation

- Update `README.md` for new CLI commands or API changes.
- Module/class/function docstrings for all public API (Google style).
- Add to `CHANGELOG.md` under "Unreleased" for user-facing changes.
