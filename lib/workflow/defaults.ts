/**
 * workflow/defaults.ts — Default workflow configuration.
 */
import {
  type WorkflowConfig,
  StateType,
  ExecutionMode,
  ReviewPolicy,
  TestPolicy,
  Action,
  WorkflowEvent,
  ReviewCheck,
} from "./types.js";

export const DEFAULT_WORKFLOW: WorkflowConfig = {
  initial: "planning",
  reviewPolicy: ReviewPolicy.HUMAN,
  testPolicy: TestPolicy.SKIP,
  roleExecution: ExecutionMode.PARALLEL,
  states: {
    // ── Main pipeline (happy path) ──────────────────────────────
    planning: {
      type: StateType.HOLD,
      label: "Planning",
      color: "#95a5a6",
      on: { [WorkflowEvent.APPROVE]: "todo" },
    },
    todo: {
      type: StateType.QUEUE,
      role: "developer",
      label: "To Do",
      color: "#0366d6",
      priority: 1,
      on: { [WorkflowEvent.PICKUP]: "doing" },
    },
    doing: {
      type: StateType.ACTIVE,
      role: "developer",
      label: "Doing",
      color: "#f0ad4e",
      on: {
        [WorkflowEvent.COMPLETE]: { target: "toReview", actions: [Action.DETECT_PR] },
        [WorkflowEvent.BLOCKED]: "refining",
      },
    },
    toReview: {
      type: StateType.QUEUE,
      role: "reviewer",
      label: "To Review",
      color: "#7057ff",
      priority: 2,
      check: ReviewCheck.PR_APPROVED,
      on: {
        [WorkflowEvent.PICKUP]: "reviewing",
        [WorkflowEvent.APPROVED]: { target: "toTest", actions: [Action.MERGE_PR, Action.GIT_PULL] },
        [WorkflowEvent.SKIP]: { target: "toTest", actions: [Action.MERGE_PR, Action.GIT_PULL] },
        [WorkflowEvent.MERGE_FAILED]: "toImprove",
        [WorkflowEvent.CHANGES_REQUESTED]: "toImprove",
        [WorkflowEvent.MERGE_CONFLICT]: "toImprove",
        [WorkflowEvent.PR_CLOSED]: { target: "rejected", actions: [Action.CLOSE_ISSUE] },
      },
    },
    reviewing: {
      type: StateType.ACTIVE,
      role: "reviewer",
      label: "Reviewing",
      color: "#c5def5",
      on: {
        [WorkflowEvent.APPROVE]: { target: "toTest", actions: [Action.MERGE_PR, Action.GIT_PULL] },
        [WorkflowEvent.REJECT]: "toImprove",
        [WorkflowEvent.BLOCKED]: "refining",
      },
    },
    // ── Test phase (skipped by default via testPolicy: skip) ────
    toTest: {
      type: StateType.QUEUE,
      role: "tester",
      label: "To Test",
      color: "#5bc0de",
      priority: 2,
      on: {
        [WorkflowEvent.PICKUP]: "testing",
        [WorkflowEvent.SKIP]: { target: "done", actions: [Action.CLOSE_ISSUE] },
      },
    },
    testing: {
      type: StateType.ACTIVE,
      role: "tester",
      label: "Testing",
      color: "#9b59b6",
      on: {
        [WorkflowEvent.PASS]: { target: "done", actions: [Action.CLOSE_ISSUE] },
        [WorkflowEvent.FAIL]: { target: "toImprove", actions: [Action.REOPEN_ISSUE] },
        [WorkflowEvent.REFINE]: "refining",
        [WorkflowEvent.BLOCKED]: "refining",
      },
    },
    done: {
      type: StateType.TERMINAL,
      label: "Done",
      color: "#5cb85c",
    },
    rejected: {
      type: StateType.TERMINAL,
      label: "Rejected",
      color: "#e11d48",
    },

    // ── Side paths (loops back into main pipeline) ──────────────
    toImprove: {
      type: StateType.QUEUE,
      role: "developer",
      label: "To Improve",
      color: "#d9534f",
      priority: 3,
      on: { [WorkflowEvent.PICKUP]: "doing" },
    },
    refining: {
      type: StateType.HOLD,
      label: "Refining",
      color: "#f39c12",
      on: { [WorkflowEvent.APPROVE]: "todo" },
    },

    // ── Architect research pipeline ──────────────────────────────
    toResearch: {
      type: StateType.QUEUE,
      role: "architect",
      label: "To Research",
      color: "#0075ca",
      priority: 1,
      on: { [WorkflowEvent.PICKUP]: "researching" },
    },
    researching: {
      type: StateType.ACTIVE,
      role: "architect",
      label: "Researching",
      color: "#4a90e2",
      on: {
        [WorkflowEvent.COMPLETE]: { target: "done", actions: [Action.CLOSE_ISSUE] },
        [WorkflowEvent.BLOCKED]: "refining",
      },
    },

  },
};
