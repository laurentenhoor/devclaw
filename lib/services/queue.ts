/**
 * Queue service — workflow queue helpers.
 */
import {
  DEFAULT_WORKFLOW,
  StateType,
  type WorkflowConfig,
  type Role,
} from "../workflow/index.js";

/**
 * Get state labels grouped by type from workflow config.
 * Returns { hold, active, queue } — terminal states excluded.
 */
export function getStateLabelsByType(
  workflow: WorkflowConfig = DEFAULT_WORKFLOW,
): Record<"hold" | "active" | "queue", Array<{ label: string; role?: Role; priority?: number }>> {
  const result: Record<"hold" | "active" | "queue", Array<{ label: string; role?: Role; priority?: number }>> = {
    hold: [],
    active: [],
    queue: [],
  };

  for (const state of Object.values(workflow.states)) {
    const entry = { label: state.label, role: state.role, priority: state.priority };
    if (state.type === StateType.HOLD) result.hold.push(entry);
    else if (state.type === StateType.ACTIVE) result.active.push(entry);
    else if (state.type === StateType.QUEUE) result.queue.push(entry);
  }

  result.queue.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  return result;
}
