/**
 * Queue service — issue queue fetching.
 *
 * Fetches issue queues per project from the issue provider.
 * Pure functions, no tool registration or state mutation.
 */
import type { Issue } from "../providers/provider.js";
import { createProvider } from "../providers/index.js";
import type { Project } from "../projects.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QueueLabel = "To Improve" | "To Test" | "To Do";

export const QUEUE_PRIORITY: Record<QueueLabel, number> = {
  "To Improve": 3,
  "To Test": 2,
  "To Do": 1,
};

export function getTaskPriority(label: QueueLabel, issue: Issue): number {
  return QUEUE_PRIORITY[label] * 10000 - issue.iid;
}

export function getRoleForLabel(label: QueueLabel): "dev" | "qa" {
  return label === "To Test" ? "qa" : "dev";
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

export async function fetchProjectQueues(project: Project): Promise<Record<QueueLabel, Issue[]>> {
  const { provider } = await createProvider({ repo: project.repo });
  const labels: QueueLabel[] = ["To Improve", "To Test", "To Do"];
  const queues: Record<QueueLabel, Issue[]> = { "To Improve": [], "To Test": [], "To Do": [] };

  for (const label of labels) {
    try {
      const issues = await provider.listIssuesByLabel(label);
      queues[label] = issues.sort((a, b) => getTaskPriority(label, b) - getTaskPriority(label, a));
    } catch {
      queues[label] = [];
    }
  }
  return queues;
}
