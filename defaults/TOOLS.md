# TOOLS.md - DevClaw Tools

All DevClaw tools are registered as OpenClaw plugin tools. Use the tool schemas for parameter details.

## Config management

DevClaw config files (workflow.yaml, prompts) are **write-once**: created on first setup, never overwritten on restart. Your customizations are always preserved.

- `config_diff` — Compare your workflow.yaml against the built-in default. Shows what you've customized and what's new in updates.
- `config_reset` — Reset config files to defaults (creates .bak backups). Supports `target`: "workflow", "prompts", or "all".

## Project-specific overrides

To override tool behavior for a specific project, create prompt files in:
`devclaw/projects/<name>/prompts/<role>.md`
