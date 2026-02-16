/**
 * review.ts — Poll review-type states for PR status changes.
 *
 * Scans review states in the workflow and transitions issues
 * whose PR check condition (merged/approved) is met.
 * Called by the heartbeat service during its periodic sweep.
 */
import type { IssueProvider } from "../providers/provider.js";
import { PrState } from "../providers/provider.js";
import {
  Action,
  ReviewCheck,
  WorkflowEvent,
  StateType,
  type WorkflowConfig,
  type StateConfig,
} from "../workflow.js";
import { runCommand } from "../run-command.js";
import { log as auditLog } from "../audit.js";

/**
 * Scan review-type states and transition issues whose PR check condition is met.
 * Returns the number of transitions made.
 */
export async function reviewPass(opts: {
  workspaceDir: string;
  groupId: string;
  workflow: WorkflowConfig;
  provider: IssueProvider;
  repoPath: string;
  gitPullTimeoutMs?: number;
}): Promise<number> {
  const { workspaceDir, groupId, workflow, provider, repoPath, gitPullTimeoutMs = 30_000 } = opts;
  let transitions = 0;

  // Find all review-type states
  const reviewStates = Object.entries(workflow.states)
    .filter(([, s]) => s.type === StateType.REVIEW) as [string, StateConfig][];

  for (const [stateKey, state] of reviewStates) {
    if (!state.on || !state.check) continue;

    const issues = await provider.listIssuesByLabel(state.label);
    for (const issue of issues) {
      const status = await provider.getPrStatus(issue.iid);

      const conditionMet =
        (state.check === ReviewCheck.PR_MERGED && status.state === PrState.MERGED) ||
        (state.check === ReviewCheck.PR_APPROVED && (status.state === PrState.APPROVED || status.state === PrState.MERGED));

      if (!conditionMet) continue;

      // Find the success transition (first non-BLOCKED event)
      const successEvent = Object.keys(state.on).find((e) => e !== WorkflowEvent.BLOCKED);
      if (!successEvent) continue;

      const transition = state.on[successEvent];
      const targetKey = typeof transition === "string" ? transition : transition.target;
      const actions = typeof transition === "object" ? transition.actions : undefined;
      const targetState = workflow.states[targetKey];
      if (!targetState) continue;

      // Execute transition actions
      if (actions) {
        for (const action of actions) {
          switch (action) {
            case Action.GIT_PULL:
              try { await runCommand(["git", "pull"], { timeoutMs: gitPullTimeoutMs, cwd: repoPath }); } catch { /* best-effort */ }
              break;
            case Action.CLOSE_ISSUE:
              await provider.closeIssue(issue.iid);
              break;
            case Action.REOPEN_ISSUE:
              await provider.reopenIssue(issue.iid);
              break;
          }
        }
      }

      // Transition label
      await provider.transitionLabel(issue.iid, state.label, targetState.label);

      await auditLog(workspaceDir, "review_transition", {
        groupId,
        issueId: issue.iid,
        from: state.label,
        to: targetState.label,
        check: state.check,
        prState: status.state,
        prUrl: status.url,
      });

      transitions++;
    }
  }

  return transitions;
}
