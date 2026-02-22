# Upgrading DevClaw Defaults

When DevClaw is updated, it may include improvements to the default workspace files (AGENTS.md, workflow states, role prompts, etc.). This guide explains how to safely upgrade to new defaults while preserving your customizations.

## Quick Start

After updating the DevClaw plugin:

```bash
# Preview what will change
upgrade-defaults --preview

# Apply safe changes automatically
upgrade-defaults --auto

# If something goes wrong, restore the previous state
upgrade-defaults --rollback
```

## Two Strategies: `upgrade-defaults` vs `reset_defaults`

### `upgrade-defaults` — Safe Incremental Updates

**Use this for routine upgrades.** Intelligently merges new defaults into your workspace:

- ✅ **Preserves your customizations** — Compares hashes to detect what you've changed
- ✅ **Non-destructive** — Only updates files that haven't been customized
- ✅ **Preview before applying** — See exactly what will change with `--preview`
- ✅ **Reversible** — Restore previous state with `--rollback` if needed
- ✅ **Smart conflict resolution** — For customized files, prompts you to merge or skip

### `reset_defaults` — Nuclear Option

**Use this only for hard resets.** Overwrites all defaults:

- ⚠️ **Destructive** — Replaces all workspace defaults even if you customized them
- ⚠️ **Backups only** — Creates `.bak` files, but requires manual restoration
- ⚠️ **Full restart** — Best when starting fresh or clearing accumulated cruft

**When to use `reset_defaults`:**
- Starting a new project from scratch
- Complete clean slate after troubleshooting
- Resetting after extensive experimental changes you want to discard

**Normal upgrades? Use `upgrade-defaults`.**

## Workflow

### 1. Preview Changes

See what the upgrade will do without making any changes:

```bash
upgrade-defaults --preview
```

Output shows:
- Files that will be updated (not customized)
- Files that will be skipped (you customized them)
- Files with conflicts (needs manual review or merge)
- Summary of changes per file

### 2. Apply Safely

After reviewing the preview, apply the upgrade:

```bash
upgrade-defaults --auto
```

The tool:
- Updates files with no customizations
- **Skips files you customized** (no data loss)
- **Prompts for conflicts** — If you customized a file and it has new defaults, choose:
  - `merge` — Intelligent merge (if possible)
  - `keep` — Keep your version
  - `skip` — Skip for now, handle manually later

### 3. Verify

After upgrade:

```bash
# Restart your agent session so it picks up new files
/new
```

Test a few common operations to ensure everything works as expected.

### 4. Rollback (if needed)

If something goes wrong, restore the previous state:

```bash
upgrade-defaults --rollback
```

This restores all files to the state before the last upgrade. You can rollback once; multiple rollbacks are not supported.

## Examples

### Example 1: Pure Upgrade (No Customizations)

You installed DevClaw and never customized anything:

```bash
upgrade-defaults --preview
# Output: "5 files ready to update, 0 customized, 0 conflicts"

upgrade-defaults --auto
# Output: "✅ Updated 5 files. Restart with /new to load changes."
```

All defaults update cleanly.

### Example 2: Customized Workflow

You customized `devclaw/workflow.yaml`:

```bash
upgrade-defaults --preview
# Output: "5 files ready to update, 1 customized (workflow.yaml), 0 conflicts"

upgrade-defaults --auto
# Output: "✅ Updated 4 files. Skipped workflow.yaml (your customization detected)."
```

Your workflow.yaml is untouched. If you want new workflow changes, manually merge them or ask for help.

### Example 3: Conflicting Changes

You customized `devclaw/prompts/developer.md`, and the upgrade has new developer prompt content:

```bash
upgrade-defaults --preview
# Output: "5 files ready to update, 1 customized, 1 conflict (developer.md)"

upgrade-defaults --auto
# Prompt: "developer.md has new defaults but you customized it. [merge/keep/skip]?"
# → Select 'merge' for intelligent merge
# → Or 'keep' to preserve your version
```

The tool shows you what changed and helps resolve the conflict.

## What Gets Tracked

DevClaw uses hash-based version tracking to detect customizations:

- **Stored in:** `.INSTALLED_DEFAULTS` manifest in your workspace
- **Format:** Maps each file to its default hash and installation timestamp
- **Detection:** Compares current file hash to stored default hash
  - Match → file unchanged, safe to update
  - Different → you customized it, skip or merge

This allows the tool to:
- Know which files you've edited
- Detect new defaults available
- Preserve customizations safely
- Enable smart merging

## Troubleshooting

### "Some files have conflicts"

This means you customized a file and the new defaults also changed it. You have three options:

1. **`merge`** — Tool attempts intelligent merge (works best for simple additions)
2. **`keep`** — Keep your version, skip the update
3. **`skip`** — Don't update yet; manually merge later

### "Rollback failed / no previous state"

Rollback only works once and requires a previous upgrade. If you've already rolled back or this is the first upgrade, `reset_defaults` is your option:

```bash
# Hard reset to current defaults (destructive)
reset_defaults
```

### "File was updated but looks wrong"

The merge may have combined changes in unexpected ways. Check the `.bak` files created during upgrade:

```bash
# View what was there before
cat AGENTS.md.bak
```

You can manually restore from `.bak` or rollback:

```bash
upgrade-defaults --rollback
```

### "upgrade-defaults isn't recognized"

Make sure DevClaw is installed and the plugin is loaded:

```bash
openclaw plugins list

# Should show: "@laurentenhoor/devclaw" with upgrade-defaults tool
```

If not, restart the gateway:

```bash
openclaw gateway restart
```

## When to Reach Out

- **Merge conflicts you can't resolve:** Share your customization and the conflict details
- **Rollback or preview looks wrong:** Check logs with `openclaw logs` and report details
- **Files seem corrupted after upgrade:** Restore from `.bak` or contact support

## See Also

- [AGENTS.md](AGENTS.md) — DevClaw architecture and conventions
- [Defaults Upgrade Strategy](AGENTS.md#defaults-upgrade-strategy) — Technical details for architects
