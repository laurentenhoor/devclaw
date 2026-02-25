/**
 * workflow/types.ts — Type definitions for the XState-style statechart config.
 */

/** Built-in state types. */
export const StateType = {
  QUEUE: "queue",
  ACTIVE: "active",
  HOLD: "hold",
  TERMINAL: "terminal",
} as const;
export type StateType = (typeof StateType)[keyof typeof StateType];

/** Built-in execution modes for role and project parallelism. */
export const ExecutionMode = {
  PARALLEL: "parallel",
  SEQUENTIAL: "sequential",
} as const;
export type ExecutionMode = (typeof ExecutionMode)[keyof typeof ExecutionMode];

/** Review policy for PR review after developer completion. */
export const ReviewPolicy = {
  HUMAN: "human",
  AGENT: "agent",
  SKIP: "skip",
} as const;
export type ReviewPolicy = (typeof ReviewPolicy)[keyof typeof ReviewPolicy];

/** Test policy for automated testing after review. */
export const TestPolicy = {
  SKIP: "skip",
  AGENT: "agent",
} as const;
export type TestPolicy = (typeof TestPolicy)[keyof typeof TestPolicy];

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
  CHANGES_REQUESTED: "CHANGES_REQUESTED",
  MERGE_CONFLICT: "MERGE_CONFLICT",
  PASS: "PASS",
  FAIL: "FAIL",
  SKIP: "SKIP",
  REFINE: "REFINE",
  BLOCKED: "BLOCKED",
  APPROVE: "APPROVE",
  REJECT: "REJECT",
  PR_CLOSED: "PR_CLOSED",
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
  reviewPolicy?: ReviewPolicy;
  testPolicy?: TestPolicy;
  roleExecution?: ExecutionMode;
  /** Default max workers per level across all roles. Default: 2. */
  maxWorkersPerLevel?: number;
  states: Record<string, StateConfig>;
};

export type CompletionRule = {
  from: string;
  to: string;
  actions: string[];
};

/** State label type alias used by providers. */
export type StateLabel = string;
