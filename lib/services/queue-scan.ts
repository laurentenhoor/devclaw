/**
 * queue-scan.ts — Issue queue scanning helpers.
 *
 * Shared by: tick (projectTick), work-start (auto-pickup), and other consumers
 * that need to find queued issues or detect roles/levels from labels.
 */
import type { Issue, StateLabel } from "../providers/provider.js";
import type { IssueProvider } from "../providers/provider.js";
import { getLevelsForRole, getAllLevels } from "../roles/index.js";
import {
  getQueueLabels,
  getAllQueueLabels,
  detectRoleFromLabel as workflowDetectRole,
  isOwnedByOrUnclaimed,
  type WorkflowConfig,
  type Role,
} from "../workflow.js";

// ---------------------------------------------------------------------------
// Label detection
// ---------------------------------------------------------------------------

export function detectLevelFromLabels(labels: string[]): string | null {
  const lower = labels.map((l) => l.toLowerCase());

  // Priority 1: Match role:level labels (e.g., "developer:senior", "developer:senior:Ada")
  for (const l of lower) {
    const parts = l.split(":");
    if (parts.length < 2) continue;
    const level = parts[1]!;
    const all = getAllLevels();
    if (all.includes(level)) return level;
  }

  // Priority 2: Match legacy role.level labels (e.g., "dev.senior", "qa.mid")
  for (const l of lower) {
    const dot = l.indexOf(".");
    if (dot === -1) continue;
    const role = l.slice(0, dot);
    const level = l.slice(dot + 1);
    const roleLevels = getLevelsForRole(role);
    if (roleLevels.includes(level)) return level;
  }

  // Fallback: plain level name
  const all = getAllLevels();
  return all.find((l) => lower.includes(l)) ?? null;
}

/**
 * Detect role, level, and optional slot name from colon-format labels.
 * Supports both 2-segment ("developer:senior") and 3-segment ("developer:senior:Ada") formats.
 * Returns the first match found, or null if no role:level label exists.
 */
export function detectRoleLevelFromLabels(
  labels: string[],
): { role: string; level: string; name?: string } | null {
  for (const label of labels) {
    const parts = label.split(":");
    if (parts.length < 2) continue;
    const role = parts[0]!.toLowerCase();
    const level = parts[1]!.toLowerCase();
    const roleLevels = getLevelsForRole(role);
    if (roleLevels.includes(level)) {
      return { role, level, name: parts[2] };
    }
  }
  return null;
}

/**
 * Detect step routing from labels (e.g. "review:human", "test:skip").
 * Returns the routing value for the given step, or null if no routing label exists.
 */
export function detectStepRouting(
  labels: string[], step: string,
): string | null {
  const prefix = `${step}:`;
  const match = labels.find((l) => l.toLowerCase().startsWith(prefix));
  return match ? match.slice(prefix.length).toLowerCase() : null;
}

/**
 * Detect role from a label using workflow config.
 */
export function detectRoleFromLabel(
  label: StateLabel,
  workflow: WorkflowConfig,
): Role | null {
  return workflowDetectRole(workflow, label);
}

// ---------------------------------------------------------------------------
// Issue queue queries
// ---------------------------------------------------------------------------

export async function findNextIssueForRole(
  provider: Pick<IssueProvider, "listIssuesByLabel">,
  role: Role,
  workflow: WorkflowConfig,
  instanceName?: string,
): Promise<{ issue: Issue; label: StateLabel } | null> {
  const labels = getQueueLabels(workflow, role);
  for (const label of labels) {
    try {
      const issues = await provider.listIssuesByLabel(label);
      const eligible = instanceName
        ? issues.filter((i) => isOwnedByOrUnclaimed(i.labels, instanceName))
        : issues;
      if (eligible.length > 0) return { issue: eligible[eligible.length - 1]!, label };
    } catch { /* continue */ }
  }
  return null;
}

/**
 * Find next issue for any role (optional filter). Used by work_start for auto-detection.
 */
export async function findNextIssue(
  provider: Pick<IssueProvider, "listIssuesByLabel">,
  role: Role | undefined,
  workflow: WorkflowConfig,
  instanceName?: string,
): Promise<{ issue: Issue; label: StateLabel } | null> {
  const labels = role
    ? getQueueLabels(workflow, role)
    : getAllQueueLabels(workflow);

  for (const label of labels) {
    try {
      const issues = await provider.listIssuesByLabel(label);
      const eligible = instanceName
        ? issues.filter((i) => isOwnedByOrUnclaimed(i.labels, instanceName))
        : issues;
      if (eligible.length > 0) return { issue: eligible[eligible.length - 1]!, label };
    } catch { /* continue */ }
  }
  return null;
}
