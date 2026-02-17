/**
 * workflow.ts — XState-style statechart configuration for workflow states.
 *
 * The workflow config defines:
 *   - States with types (queue, active, hold, terminal)
 *   - Transitions with actions (gitPull, detectPr, closeIssue, reopenIssue)
 *   - Role assignments (dev, qa)
 *   - Priority ordering for queue states
 *
 * All workflow behavior is derived from this config — no hardcoded state names.
 */
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Built-in state types. */
export const StateType = {
  QUEUE: "queue",
  ACTIVE: "active",
  HOLD: "hold",
  TERMINAL: "terminal",
} as const;
export type StateType = (typeof StateType)[keyof typeof StateType];

/** Built-in execution modes for role and project parallelism. */
export const ExecutionMode = {
  PARALLEL: "parallel",
  SEQUENTIAL: "sequential",
} as const;
export type ExecutionMode = (typeof ExecutionMode)[keyof typeof ExecutionMode];

/** Review policy for PR review after developer completion. */
export const ReviewPolicy = {
  HUMAN: "human",
  AGENT: "agent",
  AUTO: "auto",
} as const;
export type ReviewPolicy = (typeof ReviewPolicy)[keyof typeof ReviewPolicy];

/** Role identifier. Built-in: "developer", "tester", "architect". Extensible via config. */
export type Role = string;
/** Action identifier. Built-in actions listed in `Action`; custom actions are also valid strings. */
export type TransitionAction = string;

/** Built-in transition actions. Custom actions are also valid — these are just the ones with built-in handlers. */
export const Action = {
  GIT_PULL: "gitPull",
  DETECT_PR: "detectPr",
  MERGE_PR: "mergePr",
  CLOSE_ISSUE: "closeIssue",
  REOPEN_ISSUE: "reopenIssue",
} as const;

/** Built-in review check types for review states. */
export const ReviewCheck = {
  PR_APPROVED: "prApproved",
  PR_MERGED: "prMerged",
} as const;
export type ReviewCheckType = (typeof ReviewCheck)[keyof typeof ReviewCheck];

/** Built-in workflow events. */
export const WorkflowEvent = {
  PICKUP: "PICKUP",
  COMPLETE: "COMPLETE",
  REVIEW: "REVIEW",
  APPROVED: "APPROVED",
  MERGE_FAILED: "MERGE_FAILED",
  CHANGES_REQUESTED: "CHANGES_REQUESTED",
  MERGE_CONFLICT: "MERGE_CONFLICT",
  PASS: "PASS",
  FAIL: "FAIL",
  REFINE: "REFINE",
  BLOCKED: "BLOCKED",
  APPROVE: "APPROVE",
  REJECT: "REJECT",
} as const;

export type TransitionTarget = string | {
  target: string;
  actions?: TransitionAction[];
  description?: string;
};

export type StateConfig = {
  type: StateType;
  role?: Role;
  label: string;
  color: string;
  priority?: number;
  description?: string;
  check?: ReviewCheckType;
  on?: Record<string, TransitionTarget>;
};

export type WorkflowConfig = {
  initial: string;
  reviewPolicy?: ReviewPolicy;
  states: Record<string, StateConfig>;
};

export type CompletionRule = {
  from: string;
  to: string;
  actions: string[];
};

// ---------------------------------------------------------------------------
// Default workflow — matches current hardcoded behavior
// ---------------------------------------------------------------------------

export const DEFAULT_WORKFLOW: WorkflowConfig = {
  initial: "planning",
  reviewPolicy: ReviewPolicy.AUTO,
  states: {
    // ── Main pipeline (happy path) ──────────────────────────────
    planning: {
      type: StateType.HOLD,
      label: "Planning",
      color: "#95a5a6",
      on: { [WorkflowEvent.APPROVE]: "todo" },
    },
    todo: {
      type: StateType.QUEUE,
      role: "developer",
      label: "To Do",
      color: "#428bca",
      priority: 1,
      on: { [WorkflowEvent.PICKUP]: "doing" },
    },
    doing: {
      type: StateType.ACTIVE,
      role: "developer",
      label: "Doing",
      color: "#f0ad4e",
      on: {
        [WorkflowEvent.COMPLETE]: { target: "toReview", actions: [Action.DETECT_PR] },
        [WorkflowEvent.BLOCKED]: "refining",
      },
    },
    toReview: {
      type: StateType.QUEUE,
      role: "reviewer",
      label: "To Review",
      color: "#7057ff",
      priority: 2,
      check: ReviewCheck.PR_APPROVED,
      on: {
        [WorkflowEvent.PICKUP]: "reviewing",
        [WorkflowEvent.APPROVED]: { target: "toTest", actions: [Action.MERGE_PR, Action.GIT_PULL] },
        [WorkflowEvent.MERGE_FAILED]: "toImprove",
        [WorkflowEvent.CHANGES_REQUESTED]: "toImprove",
        [WorkflowEvent.MERGE_CONFLICT]: "toImprove",
      },
    },
    reviewing: {
      type: StateType.ACTIVE,
      role: "reviewer",
      label: "Reviewing",
      color: "#c5def5",
      on: {
        [WorkflowEvent.APPROVE]: { target: "toTest", actions: [Action.MERGE_PR, Action.GIT_PULL] },
        [WorkflowEvent.REJECT]: "toImprove",
        [WorkflowEvent.BLOCKED]: "refining",
      },
    },
    toTest: {
      type: StateType.QUEUE,
      role: "tester",
      label: "To Test",
      color: "#5bc0de",
      priority: 2,
      on: { [WorkflowEvent.PICKUP]: "testing" },
    },
    testing: {
      type: StateType.ACTIVE,
      role: "tester",
      label: "Testing",
      color: "#9b59b6",
      on: {
        [WorkflowEvent.PASS]: { target: "done", actions: [Action.CLOSE_ISSUE] },
        [WorkflowEvent.FAIL]: { target: "toImprove", actions: [Action.REOPEN_ISSUE] },
        [WorkflowEvent.REFINE]: "refining",
        [WorkflowEvent.BLOCKED]: "refining",
      },
    },
    done: {
      type: StateType.TERMINAL,
      label: "Done",
      color: "#5cb85c",
    },

    // ── Side paths (loops back into main pipeline) ──────────────
    toImprove: {
      type: StateType.QUEUE,
      role: "developer",
      label: "To Improve",
      color: "#d9534f",
      priority: 3,
      on: { [WorkflowEvent.PICKUP]: "doing" },
    },
    refining: {
      type: StateType.HOLD,
      label: "Refining",
      color: "#f39c12",
      on: { [WorkflowEvent.APPROVE]: "todo" },
    },

    // ── Architect research pipeline ──────────────────────────────
    toResearch: {
      type: StateType.QUEUE,
      role: "architect",
      label: "To Research",
      color: "#0075ca",
      priority: 1,
      on: { [WorkflowEvent.PICKUP]: "researching" },
    },
    researching: {
      type: StateType.ACTIVE,
      role: "architect",
      label: "Researching",
      color: "#4a90e2",
      on: {
        // Architect completes → Planning for operator review (no auto-actions: human decides next step)
        [WorkflowEvent.COMPLETE]: { target: "planning", actions: [] },
        [WorkflowEvent.BLOCKED]: "refining",
      },
    },

  },
};

// ---------------------------------------------------------------------------
// Workflow loading
// ---------------------------------------------------------------------------

/**
 * Load workflow config for a project.
 * Delegates to loadConfig() which handles the three-layer merge.
 */
export async function loadWorkflow(
  workspaceDir: string,
  projectName?: string,
): Promise<WorkflowConfig> {
  const { loadConfig } = await import("./config/loader.js");
  const config = await loadConfig(workspaceDir, projectName);
  return config.workflow;
}

// ---------------------------------------------------------------------------
// Derived helpers — all behavior comes from the config
// ---------------------------------------------------------------------------

/**
 * Get all state labels (for GitHub/GitLab label creation).
 */
export function getStateLabels(workflow: WorkflowConfig): string[] {
  return Object.values(workflow.states).map((s) => s.label);
}

/**
 * Find the current workflow state label on an issue.
 * Pure utility — no provider dependency.
 */
export function getCurrentStateLabel(labels: string[], workflow: WorkflowConfig): string | null {
  const stateLabels = getStateLabels(workflow);
  return stateLabels.find((l) => labels.includes(l)) ?? null;
}

/**
 * Get the initial state label (the first state in the workflow, e.g. "Planning").
 * Used by task_edit_body to enforce edits only in the initial state.
 */
export function getInitialStateLabel(workflow: WorkflowConfig): string {
  return workflow.states[workflow.initial].label;
}

/**
 * Get label → color mapping.
 */
export function getLabelColors(workflow: WorkflowConfig): Record<string, string> {
  const colors: Record<string, string> = {};
  for (const state of Object.values(workflow.states)) {
    colors[state.label] = state.color;
  }
  return colors;
}

// ---------------------------------------------------------------------------
// Role:level labels — dynamic from config
// ---------------------------------------------------------------------------

/** Step routing label values — per-issue overrides for workflow steps. */
export const StepRouting = {
  HUMAN: "human",
  AGENT: "agent",
  SKIP: "skip",
} as const;
export type StepRoutingValue = (typeof StepRouting)[keyof typeof StepRouting];

/** Known step routing labels (created on the provider during project registration). */
export const STEP_ROUTING_LABELS: readonly string[] = [
  "review:human", "review:agent", "review:skip",
  "test:skip",
];

/** Step routing label color. */
const STEP_ROUTING_COLOR = "#d93f0b";

// ---------------------------------------------------------------------------
// Notify labels — channel routing for notifications
// ---------------------------------------------------------------------------

/**
 * Prefix for notify labels.
 * Format: "notify:{groupId}" (e.g., "notify:-5176490302").
 * Purpose: routes notifications to the channel that owns the issue.
 * Style: light grey — low visual weight, informational only.
 */
export const NOTIFY_LABEL_PREFIX = "notify:";

/** Light grey color for notify labels — low prominence. */
export const NOTIFY_LABEL_COLOR = "#e4e4e4";

/** Build the notify label for a given group ID. */
export function getNotifyLabel(groupId: string): string {
  return `${NOTIFY_LABEL_PREFIX}${groupId}`;
}

/**
 * Resolve which channel should receive notifications for an issue.
 * Reads the `notify:{groupId}` label to find the owning channel.
 * Falls back to channels[0] (primary) if no notify label is present.
 */
export function resolveNotifyChannel(
  issueLabels: string[],
  channels: Array<{ groupId: string; channel: string }>,
): { groupId: string; channel: string } | undefined {
  const notifyLabel = issueLabels.find((l) => l.startsWith(NOTIFY_LABEL_PREFIX));
  if (notifyLabel) {
    const taggedGroupId = notifyLabel.slice(NOTIFY_LABEL_PREFIX.length);
    return channels.find((ch) => ch.groupId === taggedGroupId) ?? channels[0];
  }
  return channels[0];
}

/**
 * Determine review routing label for an issue based on project policy and developer level.
 * Called during developer dispatch to persist the routing decision as a label.
 */
export function resolveReviewRouting(
  policy: ReviewPolicy, level: string,
): "review:human" | "review:agent" {
  if (policy === ReviewPolicy.HUMAN) return "review:human";
  if (policy === ReviewPolicy.AGENT) return "review:agent";
  // AUTO: senior → human, else agent
  return level === "senior" ? "review:human" : "review:agent";
}

/** Default colors per role for role:level labels. */
const ROLE_LABEL_COLORS: Record<string, string> = {
  developer: "#0e8a16",
  tester: "#5319e7",
  architect: "#0075ca",
  reviewer: "#d93f0b",
};

/**
 * Generate all role:level label definitions from resolved config roles.
 * Returns array of { name, color } for label creation (e.g. "developer:junior").
 */
export function getRoleLabels(
  roles: Record<string, { levels: string[]; enabled?: boolean }>,
): Array<{ name: string; color: string }> {
  const labels: Array<{ name: string; color: string }> = [];
  for (const [roleId, role] of Object.entries(roles)) {
    if (role.enabled === false) continue;
    for (const level of role.levels) {
      labels.push({
        name: `${roleId}:${level}`,
        color: getRoleLabelColor(roleId),
      });
    }
  }
  // Step routing labels (review:human, review:agent, test:skip, etc.)
  for (const routingLabel of STEP_ROUTING_LABELS) {
    labels.push({ name: routingLabel, color: STEP_ROUTING_COLOR });
  }
  return labels;
}

/**
 * Get the label color for a role. Falls back to gray for unknown roles.
 */
export function getRoleLabelColor(role: string): string {
  return ROLE_LABEL_COLORS[role] ?? "#cccccc";
}

// ---------------------------------------------------------------------------
// Queue helpers
// ---------------------------------------------------------------------------

/**
 * Get queue labels for a role, ordered by priority (highest first).
 */
export function getQueueLabels(workflow: WorkflowConfig, role: Role): string[] {
  return Object.values(workflow.states)
    .filter((s) => s.type === StateType.QUEUE && s.role === role)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    .map((s) => s.label);
}

/**
 * Get all queue labels ordered by priority (for findNextIssue).
 */
export function getAllQueueLabels(workflow: WorkflowConfig): string[] {
  return Object.values(workflow.states)
    .filter((s) => s.type === StateType.QUEUE)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    .map((s) => s.label);
}

/**
 * Get the active (in-progress) label for a role.
 */
export function getActiveLabel(workflow: WorkflowConfig, role: Role): string {
  const state = Object.values(workflow.states).find(
    (s) => s.type === StateType.ACTIVE && s.role === role,
  );
  if (!state) throw new Error(`No active state for role "${role}"`);
  return state.label;
}

/**
 * Get the revert label for a role (first queue state for that role).
 */
export function getRevertLabel(workflow: WorkflowConfig, role: Role): string {
  // Find the state that PICKUP transitions to the active state, then find its label
  const activeLabel = getActiveLabel(workflow, role);
  const activeStateKey = Object.entries(workflow.states).find(
    ([, s]) => s.label === activeLabel,
  )?.[0];

  // Find queue states that transition to this active state
  for (const [, state] of Object.entries(workflow.states)) {
    if (state.type !== StateType.QUEUE || state.role !== role) continue;
    const pickup = state.on?.[WorkflowEvent.PICKUP];
    if (pickup === activeStateKey) {
      return state.label;
    }
  }

  // Fallback: first queue state for role
  return getQueueLabels(workflow, role)[0] ?? "";
}

/**
 * Detect role from a label.
 */
export function detectRoleFromLabel(workflow: WorkflowConfig, label: string): Role | null {
  for (const state of Object.values(workflow.states)) {
    if (state.label === label && state.type === StateType.QUEUE && state.role) {
      return state.role;
    }
  }
  return null;
}

/**
 * Check if a label is a queue label.
 */
export function isQueueLabel(workflow: WorkflowConfig, label: string): boolean {
  return Object.values(workflow.states).some(
    (s) => s.label === label && s.type === StateType.QUEUE,
  );
}

/**
 * Check if a label is an active label.
 */
export function isActiveLabel(workflow: WorkflowConfig, label: string): boolean {
  return Object.values(workflow.states).some(
    (s) => s.label === label && s.type === StateType.ACTIVE,
  );
}

/**
 * Find state config by label.
 */
export function findStateByLabel(workflow: WorkflowConfig, label: string): StateConfig | null {
  return Object.values(workflow.states).find((s) => s.label === label) ?? null;
}

/**
 * Find state key by label.
 */
export function findStateKeyByLabel(workflow: WorkflowConfig, label: string): string | null {
  return Object.entries(workflow.states).find(([, s]) => s.label === label)?.[0] ?? null;
}

/**
 * Check if a role has any workflow states (queue, active, etc.).
 * Roles without workflow states are dispatched by tool only (not via normal queue).
 */
export function hasWorkflowStates(workflow: WorkflowConfig, role: Role): boolean {
  return Object.values(workflow.states).some((s) => s.role === role);
}

// ---------------------------------------------------------------------------
// Dispatch context helpers — derive PR/review needs from workflow config
// ---------------------------------------------------------------------------

/** Workflow events that indicate review/test feedback. */
const FEEDBACK_EVENTS: Set<string> = new Set([
  WorkflowEvent.CHANGES_REQUESTED,
  WorkflowEvent.MERGE_CONFLICT,
  WorkflowEvent.MERGE_FAILED,
  WorkflowEvent.REJECT,
  WorkflowEvent.FAIL,
]);

/**
 * Check if a label's state is a "feedback" state — one that issues land in
 * after review rejection, test failure, or merge conflict.
 * Used to determine if PR feedback context should be fetched during dispatch.
 */
export function isFeedbackState(workflow: WorkflowConfig, label: string): boolean {
  const stateKey = findStateKeyByLabel(workflow, label);
  if (!stateKey) return false;
  for (const state of Object.values(workflow.states)) {
    if (!state.on) continue;
    for (const [event, transition] of Object.entries(state.on)) {
      const targetKey = typeof transition === "string" ? transition : transition.target;
      if (targetKey === stateKey && FEEDBACK_EVENTS.has(event)) return true;
    }
  }
  return false;
}

/**
 * Check if a role has states with PR review checks (e.g. prApproved, prMerged).
 * Used to determine if PR context (diff + URL) should be fetched for dispatch.
 */
export function hasReviewCheck(workflow: WorkflowConfig, role: string): boolean {
  return Object.values(workflow.states).some(
    (s) => s.role === role && s.check != null,
  );
}

/**
 * Check if completing this role's active state leads to a state with a review check.
 * Used to determine if review routing labels should be applied during dispatch.
 */
export function producesReviewableWork(workflow: WorkflowConfig, role: string): boolean {
  let activeKey: string | null;
  try {
    const activeLabel = getActiveLabel(workflow, role);
    activeKey = findStateKeyByLabel(workflow, activeLabel);
  } catch { return false; }
  if (!activeKey) return false;

  const activeState = workflow.states[activeKey];
  if (!activeState.on) return false;

  for (const transition of Object.values(activeState.on)) {
    const targetKey = typeof transition === "string" ? transition : transition.target;
    const targetState = workflow.states[targetKey];
    if (targetState?.check != null) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Completion rules — derived from transitions
// ---------------------------------------------------------------------------

/**
 * Map completion result to workflow transition event name.
 * Convention: "done" → COMPLETE, others → uppercase.
 */
function resultToEvent(result: string): string {
  if (result === "done") return WorkflowEvent.COMPLETE;
  return result.toUpperCase();
}

/**
 * Get completion rule for a role:result pair.
 * Derives entirely from workflow transitions — no hardcoded role:result mapping.
 */
export function getCompletionRule(
  workflow: WorkflowConfig,
  role: Role,
  result: string,
): CompletionRule | null {
  const event = resultToEvent(result);

  let activeLabel: string;
  try {
    activeLabel = getActiveLabel(workflow, role);
  } catch { return null; }

  const activeKey = findStateKeyByLabel(workflow, activeLabel);
  if (!activeKey) return null;

  const activeState = workflow.states[activeKey];
  if (!activeState.on) return null;

  const transition = activeState.on[event];
  if (!transition) return null;

  const targetKey = typeof transition === "string" ? transition : transition.target;
  const actions = typeof transition === "object" ? transition.actions : undefined;
  const targetState = workflow.states[targetKey];
  if (!targetState) return null;

  return {
    from: activeLabel,
    to: targetState.label,
    actions: actions ?? [],
  };
}

/**
 * Get human-readable next state description.
 * Derives from target state type — no hardcoded role names.
 */
export function getNextStateDescription(
  workflow: WorkflowConfig,
  role: Role,
  result: string,
): string {
  const rule = getCompletionRule(workflow, role, result);
  if (!rule) return "";

  const targetState = findStateByLabel(workflow, rule.to);
  if (!targetState) return "";

  if (targetState.type === StateType.TERMINAL) return "Done!";
  if (targetState.type === StateType.HOLD) return "awaiting human decision";
  if (targetState.type === StateType.QUEUE && targetState.role) {
    return `${targetState.role.toUpperCase()} queue`;
  }

  return rule.to;
}

/**
 * Get emoji for a completion result.
 * Keyed by result name — role-independent.
 */
const RESULT_EMOJI: Record<string, string> = {
  done: "✅",
  pass: "🎉",
  fail: "❌",
  refine: "🤔",
  blocked: "🚫",
  approve: "✅",
  reject: "❌",
};

export function getCompletionEmoji(_role: Role, result: string): string {
  return RESULT_EMOJI[result] ?? "📋";
}

// ---------------------------------------------------------------------------
// Sync helper — ensure workflow states exist as labels in issue tracker
// ---------------------------------------------------------------------------

/**
 * Ensure all workflow state labels exist in the issue tracker.
 */
export async function ensureWorkflowLabels(
  workflow: WorkflowConfig,
  ensureLabel: (name: string, color: string) => Promise<void>,
): Promise<void> {
  const colors = getLabelColors(workflow);
  for (const [label, color] of Object.entries(colors)) {
    await ensureLabel(label, color);
  }
}
