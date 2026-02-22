/**
 * workflow_guide — Reference tool for editing workflow.yaml.
 *
 * Returns a comprehensive guide explaining the workflow config structure,
 * all enums/constrained values, the three-layer config system, and
 * common customization recipes. Designed to be read by an LLM before
 * it edits any workflow.yaml file.
 *
 * No parameters, no side effects — pure documentation.
 */
import { jsonResult } from "openclaw/plugin-sdk";
import type { ToolContext } from "../types.js";
import { requireWorkspaceDir } from "../tool-helpers.js";
import { DATA_DIR } from "../setup/migrate-layout.js";

export function createWorkflowGuideTool() {
  return (ctx: ToolContext) => ({
    name: "workflow_guide",
    label: "Workflow Guide",
    description:
      `Reference guide for editing workflow.yaml. ` +
      `Call this BEFORE making any workflow configuration changes. ` +
      `Returns the full config structure, all valid values (enums, free-form fields), ` +
      `the three-layer override system, and common recipes like enabling the test phase ` +
      `or changing the review policy.`,
    parameters: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description:
            "Optional: narrow to a specific topic. " +
            'Options: "overview", "states", "roles", "review", "testing", "timeouts", "overrides". ' +
            "Omit for the full guide.",
          enum: ["overview", "states", "roles", "review", "testing", "timeouts", "overrides"],
        },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const workspaceDir = requireWorkspaceDir(ctx);
      const dataDir = `${workspaceDir}/${DATA_DIR}`;
      const topic = params.topic as string | undefined;

      const sections: Record<string, string> = {
        overview: buildOverview(dataDir),
        states: buildStatesSection(),
        roles: buildRolesSection(),
        review: buildReviewSection(),
        testing: buildTestingSection(),
        timeouts: buildTimeoutsSection(),
        overrides: buildOverridesSection(dataDir),
      };

      if (topic && sections[topic]) {
        return jsonResult({ guide: sections[topic] });
      }

      // Full guide
      const full = Object.values(sections).join("\n\n---\n\n");
      return jsonResult({ guide: full });
    },
  });
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

function buildOverview(dataDir: string): string {
  return `# Workflow Configuration Guide

## File structure

The config file is \`workflow.yaml\`. It has three top-level keys:

\`\`\`yaml
roles:      # Role and model configuration
workflow:   # State machine definition
timeouts:   # Optional timeout overrides
\`\`\`

## Three-layer config system

Config is resolved by merging three layers (later layers override earlier):

1. **Built-in defaults** — hardcoded in the plugin, always present
2. **Workspace config** — \`${dataDir}/workflow.yaml\` — shared across all projects
3. **Project config** — \`${dataDir}/projects/<name>/workflow.yaml\` — per-project overrides

### Merge semantics
- **Objects**: deep merge (sparse override — only specify what you change)
- **Arrays**: replace entirely (levels, completionResults)
- **Primitives**: override
- **\`false\` for a role**: disables it entirely

A project config only needs the keys it wants to override. Example project override:
\`\`\`yaml
roles:
  developer:
    models:
      senior: anthropic/claude-opus-4-6
workflow:
  reviewPolicy: agent
\`\`\`
This changes only the senior developer model and review policy; everything else inherits.`;
}

function buildStatesSection(): string {
  return `# Workflow States

## State types (FIXED — 4 values, cannot add new types)

| Type       | Meaning                                        |
|------------|------------------------------------------------|
| \`queue\`    | Waiting for pickup. Must have a \`role\`. Has \`priority\` (lower = higher priority). |
| \`active\`   | Work in progress. Must have a \`role\`.          |
| \`hold\`     | Paused, waiting for human input. No role needed. |
| \`terminal\` | End state. No outgoing transitions allowed.     |

## State config fields

| Field        | Type     | Required | Constrained? | Notes |
|-------------|----------|----------|--------------|-------|
| \`type\`      | string   | yes      | FIXED enum: \`queue\`, \`active\`, \`hold\`, \`terminal\` | |
| \`role\`      | string   | for queue/active | Must match a role key from \`roles:\` section | e.g. \`developer\`, \`reviewer\`, \`tester\` |
| \`label\`     | string   | yes      | FREE — any text | Becomes a GitHub/GitLab label. Must be unique across states. |
| \`color\`     | string   | yes      | FREE — any hex color | Format: \`"#rrggbb"\`. Used for the issue label color. |
| \`priority\`  | number   | no       | FREE — any positive integer | Lower = higher priority. Only meaningful on \`queue\` states. |
| \`description\`| string  | no       | FREE — any text | Optional description for documentation. |
| \`check\`     | string   | no       | FIXED enum: \`prApproved\`, \`prMerged\` | Triggers PR status check during heartbeat. |
| \`on\`        | object   | no       | Keys are events (see below), values are transitions | |

## State names (the YAML keys)
**FREE-FORM** — you choose the key names. They must be:
- Unique within the workflow
- Valid YAML keys (no spaces — use camelCase)
- Referenced consistently in transition targets

Examples: \`planning\`, \`todo\`, \`doing\`, \`toReview\`, \`reviewing\`, \`done\`, \`toImprove\`, \`refining\`

## Workflow events (FIXED — cannot add new events)

These are the valid keys for the \`on:\` object on a state:

| Event              | Meaning                                    | Typical source |
|--------------------|--------------------------------------------|----------------|
| \`PICKUP\`           | Worker picks up from queue                 | Queue dispatch  |
| \`COMPLETE\`         | Worker finished successfully               | Worker tool     |
| \`APPROVE\`          | Human/agent approves                       | Reviewer tool   |
| \`REJECT\`           | Reviewer rejects                           | Reviewer tool   |
| \`APPROVED\`         | PR approved on GitHub/GitLab               | Heartbeat       |
| \`CHANGES_REQUESTED\`| PR has change requests or unprocessed comments | Heartbeat   |
| \`MERGE_FAILED\`     | PR merge attempt failed                    | Heartbeat       |
| \`MERGE_CONFLICT\`   | PR has merge conflicts                     | Heartbeat       |
| \`PASS\`             | Tester passes                              | Tester tool     |
| \`FAIL\`             | Tester fails                               | Tester tool     |
| \`REFINE\`           | Needs refinement                           | Tester tool     |
| \`BLOCKED\`          | Work is blocked                            | Any worker tool |

## Transition target format

Simple form — just the target state name:
\`\`\`yaml
PICKUP: doing
\`\`\`

Complex form — target with actions:
\`\`\`yaml
APPROVED:
  target: done
  actions:
    - mergePr
    - gitPull
    - closeIssue
\`\`\`

## Built-in actions (FIXED set — custom strings are ignored)

| Action         | What it does                              |
|----------------|-------------------------------------------|
| \`detectPr\`     | Detect if a PR/MR exists for the issue    |
| \`mergePr\`      | Merge the associated PR/MR                |
| \`gitPull\`      | Pull latest changes on the project repo   |
| \`closeIssue\`   | Close the issue on GitHub/GitLab          |
| \`reopenIssue\`  | Reopen the issue on GitHub/GitLab         |

## Validation rules (enforced at load time)

- \`initial\` state must exist in \`states\`
- \`queue\` and \`active\` states must have a \`role\`
- \`terminal\` states must NOT have \`on\` transitions
- All transition targets must point to existing state keys
- State labels must be unique

## Syncing labels after changes

After adding, renaming, or removing states in workflow.yaml, run the \`sync_labels\` tool to create the corresponding labels on GitHub/GitLab. Labels are only created during \`project_register\` — workflow.yaml edits are not automatically synced.

\`sync_labels\` reads the fully resolved config (built-in + workspace + project overrides) and ensures every state label, role:level label, and step routing label exists on the provider. It is idempotent — safe to run multiple times.

\`\`\`
sync_labels                         # sync all projects
sync_labels projectSlug=my-webapp   # sync one project
\`\`\``;
}

function buildRolesSection(): string {
  return `# Roles Configuration

## Built-in roles (4 defaults — can override or disable)

| Role       | Default levels          | Default level | Completion results         |
|-----------|------------------------|---------------|----------------------------|
| \`developer\`| junior, medior, senior | medior        | done, blocked              |
| \`tester\`   | junior, medior, senior | medior        | pass, fail, refine, blocked|
| \`architect\` | junior, senior         | junior        | done, blocked              |
| \`reviewer\`  | junior, senior         | junior        | approve, reject, blocked   |

## Role config fields

| Field              | Constrained?  | Notes |
|-------------------|---------------|-------|
| \`maxWorkers\`      | Must be positive integer | Maximum concurrent workers for this role. Default: 1. |
| \`levels\`          | FREE — array of strings | Define your own level names. Default model routing uses these as keys. |
| \`defaultLevel\`    | Must be one of \`levels\` | Used when no level specified on issue. |
| \`models\`          | FREE — map of level→model ID | Model IDs are free-form strings. Format: \`provider/model-name\`. |
| \`emoji\`           | FREE — map of level→emoji | Used in announcements. Any emoji string. |
| \`completionResults\`| Mapped to events | \`"done"\` maps to COMPLETE event, others map to UPPERCASE event name. Must have matching transitions in active states. |

## Default model assignments

| Level    | Default model                    |
|---------|----------------------------------|
| junior   | \`anthropic/claude-haiku-4-5\`    |
| medior   | \`anthropic/claude-sonnet-4-5\`   |
| senior   | \`anthropic/claude-opus-4-6\`     |

Architect junior defaults to \`anthropic/claude-sonnet-4-5\`.
Reviewer senior defaults to \`anthropic/claude-sonnet-4-5\`.

## Disabling a role

Set the role to \`false\`:
\`\`\`yaml
roles:
  tester: false
\`\`\`

## Adding a custom role

Define the role with all required fields. The role key must also be referenced as a \`role:\` in at least one workflow state.
\`\`\`yaml
roles:
  security_auditor:
    levels: [standard, expert]
    defaultLevel: standard
    models:
      standard: anthropic/claude-sonnet-4-5
      expert: anthropic/claude-opus-4-6
    completionResults: [done, blocked]
\`\`\`
Then add states that use \`role: security_auditor\`.

## Prompts per role

Each role can have a system prompt file:
- Workspace default: \`<dataDir>/prompts/<role>.md\`
- Project override: \`<dataDir>/projects/<name>/prompts/<role>.md\`

If a role has no prompt file, the worker gets a generic system prompt. When enabling a new role (like tester), create its prompt file.`;
}

function buildReviewSection(): string {
  return `# Review Policy

## reviewPolicy (FIXED — 3 values)

Set in \`workflow.reviewPolicy\`:

| Value    | Behavior |
|---------|----------|
| \`human\` | **(default)** All PRs wait for human approval on GitHub/GitLab. The heartbeat polls PR status and auto-merges when approved. |
| \`agent\` | Every PR is reviewed by an agent (reviewer role) before merge. Agent can approve or reject. |
| \`auto\`  | Hybrid: junior/medior developers → agent review, senior developers → human review. |

## How review routing works

1. Developer finishes work → issue moves to \`toReview\` state
2. Heartbeat checks \`reviewPolicy\` to decide routing:
   - \`human\`: issue stays in \`toReview\`, heartbeat polls PR for approval
   - \`agent\`: heartbeat dispatches a reviewer worker to check the PR
   - \`auto\`: checks the developer level that worked on the issue
3. The \`toReview\` state should have a \`check: prApproved\` field for human review flow

## Per-issue override labels (FIXED format, applied to individual issues)

| Label           | Effect |
|----------------|--------|
| \`review:human\` | Force human review for this issue regardless of policy |
| \`review:agent\` | Force agent review for this issue |
| \`review:skip\`  | Skip review entirely — go straight to done/test |
| \`test:skip\`    | Skip the test phase for this issue (if testing enabled) |

These labels are applied to the issue on GitHub/GitLab and override the global policy.

## Example: switching to agent review

\`\`\`yaml
workflow:
  reviewPolicy: agent
\`\`\`

The reviewer role must be configured (it is by default) and needs a prompt file at \`<dataDir>/prompts/reviewer.md\`.`;
}

function buildTestingSection(): string {
  return `# Test Phase (Optional)

The test phase is **disabled by default**. When enabled, issues go through automated QA after review, before closing.

## Default flow (no test phase)
\`\`\`
Planning → To Do → Doing → To Review → [PR approved] → Done (auto-merge + close)
\`\`\`

## Flow with test phase enabled
\`\`\`
Planning → To Do → Doing → To Review → [PR approved] → To Test → Testing → Done
\`\`\`

## How to enable the test phase

Four changes needed:

### 1. Uncomment the toTest and testing states
Add these states to your workflow (they're commented out in the default workflow.yaml):
\`\`\`yaml
    toTest:
      type: queue
      role: tester
      label: To Test
      color: "#5bc0de"
      priority: 2
      on:
        PICKUP: testing
    testing:
      type: active
      role: tester
      label: Testing
      color: "#9b59b6"
      on:
        PASS:
          target: done
          actions:
            - closeIssue
        FAIL:
          target: toImprove
          actions:
            - reopenIssue
        REFINE: refining
        BLOCKED: refining
\`\`\`

### 2. Change APPROVED targets from "done" to "toTest"
In the \`toReview\` state:
\`\`\`yaml
    toReview:
      on:
        APPROVED:
          target: toTest        # was: done
          actions:
            - mergePr
            - gitPull           # remove closeIssue — tester closes it
\`\`\`

In the \`reviewing\` state (if using agent review):
\`\`\`yaml
    reviewing:
      on:
        APPROVE:
          target: toTest        # was: done
          actions:
            - mergePr
            - gitPull           # remove closeIssue — tester closes it
\`\`\`

### 3. Remove closeIssue from the APPROVED/APPROVE actions
The tester now closes the issue on PASS (via the testing state's PASS action).

### 4. Create a tester prompt file
Create \`<dataDir>/prompts/tester.md\` with instructions for the QA role.
For project-specific: \`<dataDir>/projects/<name>/prompts/tester.md\`.

## Per-issue skip
Add the \`test:skip\` label to an issue to skip testing for that specific issue.`;
}

function buildTimeoutsSection(): string {
  return `# Timeouts

All timeout values are optional. Specify only the ones you want to override.

\`\`\`yaml
timeouts:
  gitPullMs: 30000          # Git pull timeout (default: 30s)
  gatewayMs: 15000          # Gateway API timeout (default: 15s)
  sessionPatchMs: 30000     # Session patch timeout (default: 30s)
  dispatchMs: 600000        # Worker dispatch timeout (default: 10min)
  staleWorkerHours: 2       # Hours before a worker is considered stale (default: 2)
  sessionContextBudget: 0.6 # Clear session when context exceeds 60% of limit (default: 0.6)
\`\`\`

| Field             | Type   | Default  | Notes |
|-------------------|--------|----------|-------|
| \`gitPullMs\`       | number | 30000    | Must be positive. Milliseconds. |
| \`gatewayMs\`       | number | 15000    | Must be positive. Milliseconds. |
| \`sessionPatchMs\`  | number | 30000    | Must be positive. Milliseconds. |
| \`dispatchMs\`      | number | 600000   | Must be positive. Milliseconds. How long a worker dispatch can take. |
| \`staleWorkerHours\`| number | 2        | Must be positive. Hours. After this, worker is flagged as stale. |
| \`sessionContextBudget\` | number | 0.6 | 0-1. Clear session when context exceeds this ratio. Set to 1.0 to disable. Skips clear on same-issue re-dispatch (feedback cycle). |`;
}

function buildOverridesSection(dataDir: string): string {
  return `# Project-Level Overrides

## File location
\`${dataDir}/projects/<project-name>/workflow.yaml\`

## What can be overridden per project
Everything. A project workflow.yaml has the same structure as the workspace one. Only specify what differs.

## Common override patterns

### Different review policy for one project
\`\`\`yaml
workflow:
  reviewPolicy: auto
\`\`\`

### Upgrade models for a critical project
\`\`\`yaml
roles:
  developer:
    models:
      medior: anthropic/claude-opus-4-6
\`\`\`

### Disable tester for one project
\`\`\`yaml
roles:
  tester: false
\`\`\`

### Use different model provider
\`\`\`yaml
roles:
  developer:
    models:
      junior: google/gemini-2.0-flash
      medior: google/gemini-2.5-pro
      senior: anthropic/claude-opus-4-6
\`\`\`

### Allow concurrent developers on a project
\`\`\`yaml
roles:
  developer:
    maxWorkers: 3  # Allow up to 3 developers working in parallel
\`\`\`

### Override timeouts for a slow repo
\`\`\`yaml
timeouts:
  gitPullMs: 60000
  dispatchMs: 900000
\`\`\`

## Prompt overrides
Place role-specific prompts in:
\`${dataDir}/projects/<project-name>/prompts/<role>.md\`

These completely replace (not merge with) the workspace-level prompts for that role.`;
}
