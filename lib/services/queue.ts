/**
 * Queue service — issue queue fetching.
 *
 * Fetches issue queues per project from the issue provider.
 * Uses workflow config for queue labels — no hardcoded state names.
 */
import type { Issue } from "../providers/provider.js";
import { createProvider } from "../providers/index.js";
import type { Project } from "../projects.js";
import {
  DEFAULT_WORKFLOW,
  StateType,
  type WorkflowConfig,
  type Role,
} from "../workflow.js";

// ---------------------------------------------------------------------------
// Workflow-driven helpers
// ---------------------------------------------------------------------------

/**
 * Get queue labels with their priorities from workflow config.
 * Returns labels sorted by priority (highest first).
 */
export function getQueueLabelsWithPriority(
  workflow: WorkflowConfig = DEFAULT_WORKFLOW,
): Array<{ label: string; priority: number; role?: Role }> {
  const labels: Array<{ label: string; priority: number; role?: Role }> = [];

  for (const state of Object.values(workflow.states)) {
    if (state.type === StateType.QUEUE) {
      labels.push({
        label: state.label,
        priority: state.priority ?? 0,
        role: state.role,
      });
    }
  }

  return labels.sort((a, b) => b.priority - a.priority);
}

/**
 * Get the priority for a queue label from workflow config.
 */
export function getQueuePriority(
  label: string,
  workflow: WorkflowConfig = DEFAULT_WORKFLOW,
): number {
  const state = Object.values(workflow.states).find(
    (s) => s.label === label && s.type === "queue",
  );
  return state?.priority ?? 0;
}

/**
 * Get task priority for sorting (higher = more urgent).
 * Priority = queue_priority * 10000 - issue_id (older issues first within same queue).
 */
export function getTaskPriority(
  label: string,
  issue: Issue,
  workflow: WorkflowConfig = DEFAULT_WORKFLOW,
): number {
  const priority = getQueuePriority(label, workflow);
  return priority * 10000 - issue.iid;
}

/**
 * Get the role assigned to a queue label.
 */
export function getRoleForLabel(
  label: string,
  workflow: WorkflowConfig = DEFAULT_WORKFLOW,
): Role | null {
  const state = Object.values(workflow.states).find(
    (s) => s.label === label && s.type === "queue",
  );
  return state?.role ?? null;
}

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

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/**
 * Fetch all queued issues for a project, grouped by queue label.
 * Uses workflow config for queue labels.
 */
export async function fetchProjectQueues(
  project: Project,
  workflow: WorkflowConfig = DEFAULT_WORKFLOW,
): Promise<Record<string, Issue[]>> {
  const { provider } = await createProvider({ repo: project.repo, provider: project.provider });
  const queueLabels = getQueueLabelsWithPriority(workflow);
  const queues: Record<string, Issue[]> = {};

  // Initialize all queue labels with empty arrays
  for (const { label } of queueLabels) {
    queues[label] = [];
  }

  // Fetch issues for each queue
  for (const { label } of queueLabels) {
    try {
      const issues = await provider.listIssuesByLabel(label);
      queues[label] = issues.sort(
        (a, b) => getTaskPriority(label, b, workflow) - getTaskPriority(label, a, workflow),
      );
    } catch {
      queues[label] = [];
    }
  }

  return queues;
}

/**
 * Get total count of queued issues across all queues.
 */
export function getTotalQueuedCount(queues: Record<string, Issue[]>): number {
  return Object.values(queues).reduce((sum, issues) => sum + issues.length, 0);
}
