/**
 * workflow/labels.ts — Label formatting, detection, and routing helpers.
 */
import type { WorkflowConfig, ReviewPolicy, TestPolicy } from "./types.js";
import { ReviewPolicy as RP, TestPolicy as TP } from "./types.js";
import { getLabelColors } from "./queries.js";

// ---------------------------------------------------------------------------
// Step routing labels
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
export const STEP_ROUTING_COLOR = "#d93f0b";

// ---------------------------------------------------------------------------
// Notify labels — channel routing for notifications
// ---------------------------------------------------------------------------

export const NOTIFY_LABEL_PREFIX = "notify:";
export const NOTIFY_LABEL_COLOR = "#e4e4e4";

/** Build the notify label for a channel endpoint. */
export function getNotifyLabel(channel: string, nameOrIndex: string): string {
  return `${NOTIFY_LABEL_PREFIX}${channel}:${nameOrIndex}`;
}

/**
 * Resolve which channel should receive notifications for an issue.
 */
export function resolveNotifyChannel(
  issueLabels: string[],
  channels: Array<{ groupId: string; channel: string; name?: string; accountId?: string }>,
): { groupId: string; channel: string; accountId?: string } | undefined {
  const notifyLabel = issueLabels.find((l) => l.startsWith(NOTIFY_LABEL_PREFIX));
  if (notifyLabel) {
    const value = notifyLabel.slice(NOTIFY_LABEL_PREFIX.length);
    const colonIdx = value.indexOf(":");
    if (colonIdx !== -1) {
      const channelType = value.slice(0, colonIdx);
      const channelName = value.slice(colonIdx + 1);
      return channels.find(
        (ch) => ch.channel === channelType && (ch.name === channelName || String(channels.indexOf(ch)) === channelName),
      ) ?? channels[0];
    }
    return channels.find((ch) => ch.groupId === value) ?? channels[0];
  }
  return channels[0];
}

// ---------------------------------------------------------------------------
// Owner labels — instance identity on issues
// ---------------------------------------------------------------------------

export const OWNER_LABEL_PREFIX = "owner:";
export const OWNER_LABEL_COLOR = "#e4e4e4";

/** Build the owner label for a given instance name. */
export function getOwnerLabel(instanceName: string): string {
  return `${OWNER_LABEL_PREFIX}${instanceName}`;
}

/** Extract the instance name from an issue's labels, or null if unclaimed. */
export function detectOwner(issueLabels: string[]): string | null {
  const label = issueLabels.find((l) => l.startsWith(OWNER_LABEL_PREFIX));
  return label ? label.slice(OWNER_LABEL_PREFIX.length) : null;
}

/** Check if an issue is owned by the given instance or unclaimed. */
export function isOwnedByOrUnclaimed(
  issueLabels: string[],
  instanceName: string,
): boolean {
  const owner = detectOwner(issueLabels);
  return owner === null || owner === instanceName;
}

// ---------------------------------------------------------------------------
// Review routing
// ---------------------------------------------------------------------------

/**
 * Determine review routing label for an issue based on project policy and developer level.
 */
export function resolveReviewRouting(
  policy: ReviewPolicy, _level: string,
): "review:human" | "review:agent" | "review:skip" {
  if (policy === RP.HUMAN) return "review:human";
  if (policy === RP.AGENT) return "review:agent";
  if (policy === RP.SKIP) return "review:skip";
  return "review:human";
}

/**
 * Determine test routing label for an issue based on project policy.
 */
export function resolveTestRouting(
  policy: TestPolicy, _level: string,
): "test:skip" | "test:agent" {
  if (policy === TP.AGENT) return "test:agent";
  return "test:skip";
}

// ---------------------------------------------------------------------------
// Role labels
// ---------------------------------------------------------------------------

/** Default colors per role for role:level labels. */
const ROLE_LABEL_COLORS: Record<string, string> = {
  developer: "#0e8a16",
  tester: "#5319e7",
  architect: "#0075ca",
  reviewer: "#d93f0b",
};

/**
 * Generate all role:level label definitions from resolved config roles.
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
  for (const routingLabel of STEP_ROUTING_LABELS) {
    labels.push({ name: routingLabel, color: STEP_ROUTING_COLOR });
  }
  return labels;
}

/** Get the label color for a role. Falls back to gray for unknown roles. */
export function getRoleLabelColor(role: string): string {
  return ROLE_LABEL_COLORS[role] ?? "#cccccc";
}

// ---------------------------------------------------------------------------
// Sync helper
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
