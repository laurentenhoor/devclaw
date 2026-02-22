/**
 * config/types.ts — Types for the unified DevClaw configuration.
 *
 * A single workflow.yaml combines roles, models, and workflow.
 * Three-layer resolution: built-in → workspace → per-project.
 */
import type { WorkflowConfig } from "../workflow.js";

/**
 * Role override in workflow.yaml. All fields optional — only override what you need.
 * Set to `false` to disable a role entirely for a project.
 */
/** Model entry: plain string or object with per-level maxWorkers override. */
export type ModelEntry = string | { model: string; maxWorkers?: number };

export type RoleOverride = {
  maxWorkers?: number; // @deprecated — kept for backward compat, ignored by resolver
  levels?: string[];
  defaultLevel?: string;
  models?: Record<string, ModelEntry>;
  emoji?: Record<string, string>;
  completionResults?: string[];
};

/**
 * Configurable timeout values (in milliseconds).
 * All fields optional — defaults applied at resolution time.
 */
export type TimeoutConfig = {
  gitPullMs?: number;
  gatewayMs?: number;
  sessionPatchMs?: number;
  dispatchMs?: number;
  staleWorkerHours?: number;
  /** Context budget ratio (0-1). Clear session when context exceeds this fraction of the context window. Default: 0.6 */
  sessionContextBudget?: number;
};

/**
 * The full workflow.yaml shape.
 * All fields optional — missing fields inherit from the layer below.
 */
export type DevClawConfig = {
  roles?: Record<string, RoleOverride | false>;
  workflow?: Partial<WorkflowConfig>;
  timeouts?: TimeoutConfig;
};

/**
 * Fully resolved timeout config — all fields present with defaults.
 */
export type ResolvedTimeouts = {
  gitPullMs: number;
  gatewayMs: number;
  sessionPatchMs: number;
  dispatchMs: number;
  staleWorkerHours: number;
  /** Context budget ratio (0-1). Clear session when context exceeds this fraction of the context window. Default: 0.6 */
  sessionContextBudget: number;
};

/**
 * Fully resolved config — all fields guaranteed present.
 * Built by merging three layers over the built-in defaults.
 */
export type ResolvedConfig = {
  roles: Record<string, ResolvedRoleConfig>;
  workflow: WorkflowConfig;
  timeouts: ResolvedTimeouts;
};

/**
 * Fully resolved role config — all fields present.
 */
export type ResolvedRoleConfig = {
  /** Per-level max workers. Resolved from: per-model maxWorkers → workflow maxWorkersPerLevel → default 2. */
  levelMaxWorkers: Record<string, number>;
  levels: string[];
  defaultLevel: string;
  /** Flattened model map (string IDs only, for existing consumers). */
  models: Record<string, string>;
  emoji: Record<string, string>;
  completionResults: string[];
  enabled: boolean;
};
