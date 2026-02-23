/**
 * test-skip.ts — Auto-transition test:skip issues through the test queue.
 *
 * When testPolicy is "skip" (default), issues arrive in the test queue
 * with a test:skip label. This pass auto-transitions them to done,
 * executing the SKIP event's configured actions (e.g. closeIssue).
 *
 * Mirrors reviewPass() in review.ts — called by the heartbeat service.
 */
import type { IssueProvider } from "../providers/provider.js";
import {
  Action,
  StateType,
  WorkflowEvent,
  type WorkflowConfig,
  type StateConfig,
} from "../workflow.js";
import { detectStepRouting } from "./queue-scan.js";
import { log as auditLog } from "../audit.js";

/**
 * Scan test queue states and auto-transition issues with test:skip.
 * Returns the number of transitions made.
 */
export async function testSkipPass(opts: {
  workspaceDir: string;
  projectName: string;
  workflow: WorkflowConfig;
  provider: IssueProvider;
}): Promise<number> {
  const { workspaceDir, projectName, workflow, provider } = opts;
  let transitions = 0;

  // Find test queue states (role=tester, type=queue) that have a SKIP event
  const testQueueStates = Object.entries(workflow.states)
    .filter(([, s]) => s.role === "tester" && s.type === StateType.QUEUE) as [string, StateConfig][];

  for (const [_stateKey, state] of testQueueStates) {
    const skipTransition = state.on?.[WorkflowEvent.SKIP];
    if (!skipTransition) continue;

    const targetKey = typeof skipTransition === "string" ? skipTransition : skipTransition.target;
    const actions = typeof skipTransition === "object" ? skipTransition.actions : undefined;
    const targetState = workflow.states[targetKey];
    if (!targetState) continue;

    const issues = await provider.listIssuesByLabel(state.label);
    for (const issue of issues) {
      const routing = detectStepRouting(issue.labels, "test");
      if (routing !== "skip") continue;

      // Execute SKIP transition actions
      if (actions) {
        for (const action of actions) {
          switch (action) {
            case Action.CLOSE_ISSUE:
              try { await provider.closeIssue(issue.iid); } catch { /* best-effort */ }
              break;
            case Action.REOPEN_ISSUE:
              try { await provider.reopenIssue(issue.iid); } catch { /* best-effort */ }
              break;
          }
        }
      }

      // Transition label
      await provider.transitionLabel(issue.iid, state.label, targetState.label);

      await auditLog(workspaceDir, "test_skip_transition", {
        project: projectName,
        issueId: issue.iid,
        from: state.label,
        to: targetState.label,
        reason: "test:skip",
      });

      transitions++;
    }
  }

  return transitions;
}
