/**
 * workflow/queries.ts — Pure query functions over workflow configuration.
 */
import {
  type WorkflowConfig,
  type StateConfig,
  type Role,
  StateType,
  WorkflowEvent,
} from "./types.js";

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
  const activeLabel = getActiveLabel(workflow, role);
  const activeStateKey = Object.entries(workflow.states).find(
    ([, s]) => s.label === activeLabel,
  )?.[0];

  for (const [, state] of Object.entries(workflow.states)) {
    if (state.type !== StateType.QUEUE || state.role !== role) continue;
    const pickup = state.on?.[WorkflowEvent.PICKUP];
    if (pickup === activeStateKey) {
      return state.label;
    }
  }

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
 */
export function hasWorkflowStates(workflow: WorkflowConfig, role: Role): boolean {
  return Object.values(workflow.states).some((s) => s.role === role);
}

/** Workflow events that indicate review/test feedback. */
const FEEDBACK_EVENTS: Set<string> = new Set([
  WorkflowEvent.CHANGES_REQUESTED,
  WorkflowEvent.MERGE_CONFLICT,
  WorkflowEvent.MERGE_FAILED,
  WorkflowEvent.REJECT,
  WorkflowEvent.FAIL,
  WorkflowEvent.PR_CLOSED,
]);

/**
 * Check if a label's state is a "feedback" state — one that issues land in
 * after review rejection, test failure, or merge conflict.
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
 */
export function hasReviewCheck(workflow: WorkflowConfig, role: string): boolean {
  return Object.values(workflow.states).some(
    (s) => s.role === role && s.check != null,
  );
}

/**
 * Check if completing this role's active state leads to a state with a review check.
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

/**
 * Check if the workflow has a test phase (any queue state with role=tester).
 */
export function hasTestPhase(workflow: WorkflowConfig): boolean {
  return Object.values(workflow.states).some(
    (s) => s.role === "tester" && s.type === StateType.QUEUE,
  );
}

/**
 * Load workflow config for a project.
 * Delegates to loadConfig() which handles the three-layer merge.
 */
export async function loadWorkflow(
  workspaceDir: string,
  projectName?: string,
): Promise<WorkflowConfig> {
  const { loadConfig } = await import("../config/loader.js");
  const config = await loadConfig(workspaceDir, projectName);
  return config.workflow;
}
