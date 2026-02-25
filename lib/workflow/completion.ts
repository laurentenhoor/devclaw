/**
 * workflow/completion.ts — Completion rules derived from workflow transitions.
 */
import {
  type WorkflowConfig,
  type CompletionRule,
  type Role,
  StateType,
  WorkflowEvent,
} from "./types.js";
import { getActiveLabel, findStateKeyByLabel, findStateByLabel } from "./queries.js";

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

/** Emoji map for completion results. */
const RESULT_EMOJI: Record<string, string> = {
  done: "✅",
  pass: "🎉",
  fail: "❌",
  refine: "🤔",
  blocked: "🚫",
  approve: "✅",
  reject: "❌",
};

/** Get emoji for a completion result. */
export function getCompletionEmoji(_role: Role, result: string): string {
  return RESULT_EMOJI[result] ?? "📋";
}
