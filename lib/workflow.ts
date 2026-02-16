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
  REVIEW: "review",
} as const;
export type StateType = (typeof StateType)[keyof typeof StateType];

/** Built-in execution modes for role and project parallelism. */
export const ExecutionMode = {
  PARALLEL: "parallel",
  SEQUENTIAL: "sequential",
} as const;
export type ExecutionMode = (typeof ExecutionMode)[keyof typeof ExecutionMode];

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
  PASS: "PASS",
  FAIL: "FAIL",
  REFINE: "REFINE",
  BLOCKED: "BLOCKED",
  APPROVE: "APPROVE",
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
        [WorkflowEvent.COMPLETE]: { target: "toTest", actions: [Action.GIT_PULL, Action.DETECT_PR] },
        [WorkflowEvent.REVIEW]: { target: "reviewing", actions: [Action.DETECT_PR] },
        [WorkflowEvent.BLOCKED]: "refining",
      },
    },
    reviewing: {
      type: StateType.REVIEW,
      label: "In Review",
      color: "#c5def5",
      check: ReviewCheck.PR_APPROVED,
      on: {
        [WorkflowEvent.APPROVED]: { target: "toTest", actions: [Action.MERGE_PR, Action.GIT_PULL] },
        [WorkflowEvent.MERGE_FAILED]: "toImprove",
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

    // ── Architect track ─────────────────────────────────────────
    toDesign: {
      type: StateType.QUEUE,
      role: "architect",
      label: "To Design",
      color: "#0075ca",
      priority: 1,
      on: { [WorkflowEvent.PICKUP]: "designing" },
    },
    designing: {
      type: StateType.ACTIVE,
      role: "architect",
      label: "Designing",
      color: "#d4c5f9",
      on: {
        [WorkflowEvent.COMPLETE]: "planning",
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
 * Get label → color mapping.
 */
export function getLabelColors(workflow: WorkflowConfig): Record<string, string> {
  const colors: Record<string, string> = {};
  for (const state of Object.values(workflow.states)) {
    colors[state.label] = state.color;
  }
  return colors;
}

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

// ---------------------------------------------------------------------------
// Completion rules — derived from transitions
// ---------------------------------------------------------------------------

/**
 * Map completion result to workflow transition event name.
 * Convention: "done" → COMPLETE, others → uppercase.
 */
function resultToEvent(result: string): string {
  if (result === "done") return WorkflowEvent.COMPLETE;
  if (result === "review") return WorkflowEvent.REVIEW;
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
  if (targetState.type === StateType.REVIEW) return "awaiting PR review";
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
  review: "👀",
  pass: "🎉",
  fail: "❌",
  refine: "🤔",
  blocked: "🚫",
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
