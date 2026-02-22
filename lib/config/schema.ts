/**
 * config/schema.ts — Zod validation for DevClaw workflow config.
 *
 * Validates workflow YAML at load time with clear error messages.
 * Enforces: transition targets exist, queue states have roles,
 * terminal states have no outgoing transitions.
 */
import { z } from "zod";
import { StateType } from "../workflow.js";

const STATE_TYPES = Object.values(StateType) as [string, ...string[]];

const TransitionTargetSchema = z.union([
  z.string(),
  z.object({
    target: z.string(),
    actions: z.array(z.string()).optional(),
    description: z.string().optional(),
  }),
]);

const StateConfigSchema = z.object({
  type: z.enum(STATE_TYPES),
  role: z.string().optional(),
  label: z.string(),
  color: z.string(),
  priority: z.number().optional(),
  description: z.string().optional(),
  check: z.string().optional(),
  on: z.record(z.string(), TransitionTargetSchema).optional(),
});

const WorkflowConfigSchema = z.object({
  initial: z.string(),
  reviewPolicy: z.enum(["human", "agent", "auto"]).optional(),
  roleExecution: z.enum(["parallel", "sequential"]).optional(),
  maxWorkersPerLevel: z.number().int().positive().optional(),
  states: z.record(z.string(), StateConfigSchema),
});

const ModelEntrySchema = z.union([
  z.string(),
  z.object({
    model: z.string(),
    maxWorkers: z.number().int().positive().optional(),
  }),
]);

const RoleOverrideSchema = z.union([
  z.literal(false),
  z.object({
    maxWorkers: z.number().int().positive().optional(), // deprecated, kept for backward compat
    levels: z.array(z.string()).optional(),
    defaultLevel: z.string().optional(),
    models: z.record(z.string(), ModelEntrySchema).optional(),
    emoji: z.record(z.string(), z.string()).optional(),
    completionResults: z.array(z.string()).optional(),
  }),
]);

const TimeoutConfigSchema = z.object({
  gitPullMs: z.number().positive().optional(),
  gatewayMs: z.number().positive().optional(),
  sessionPatchMs: z.number().positive().optional(),
  dispatchMs: z.number().positive().optional(),
  staleWorkerHours: z.number().positive().optional(),
  sessionContextBudget: z.number().min(0).max(1).optional(),
}).optional();

export const DevClawConfigSchema = z.object({
  roles: z.record(z.string(), RoleOverrideSchema).optional(),
  workflow: WorkflowConfigSchema.partial().optional(),
  timeouts: TimeoutConfigSchema,
});

/**
 * Validate a raw parsed config object.
 * Returns the validated config or throws with a descriptive error.
 */
export function validateConfig(raw: unknown): void {
  DevClawConfigSchema.parse(raw);
}

/**
 * Validate structural integrity of a fully-resolved workflow config.
 * Checks cross-references that Zod schema alone can't enforce:
 * - All transition targets point to existing states
 * - Queue states have a role assigned
 * - Terminal states have no outgoing transitions
 */
export function validateWorkflowIntegrity(
  workflow: { initial: string; states: Record<string, { type: string; role?: string; on?: Record<string, unknown> }> },
): string[] {
  const errors: string[] = [];
  const stateKeys = new Set(Object.keys(workflow.states));

  if (!stateKeys.has(workflow.initial)) {
    errors.push(`Initial state "${workflow.initial}" does not exist in states`);
  }

  for (const [key, state] of Object.entries(workflow.states)) {
    if (state.type === StateType.QUEUE && !state.role) {
      errors.push(`Queue state "${key}" must have a role assigned`);
    }

    if (state.type === StateType.ACTIVE && !state.role) {
      errors.push(`Active state "${key}" must have a role assigned`);
    }

    if (state.type === StateType.TERMINAL && state.on && Object.keys(state.on).length > 0) {
      errors.push(`Terminal state "${key}" should not have outgoing transitions`);
    }

    if (state.on) {
      for (const [event, transition] of Object.entries(state.on)) {
        const target = typeof transition === "string"
          ? transition
          : (transition as { target: string }).target;
        if (!stateKeys.has(target)) {
          errors.push(`State "${key}" transition "${event}" targets non-existent state "${target}"`);
        }
      }
    }
  }

  return errors;
}
