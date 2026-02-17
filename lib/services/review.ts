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
  filterIssuesByGroup,
  type WorkflowConfig,
  type StateConfig,
} from "../workflow.js";
import { detectStepRouting } from "./queue-scan.js";
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
  /** Called after a successful PR merge (for notifications). */
  onMerge?: (issueId: number, prUrl: string | null, prTitle?: string, sourceBranch?: string) => void;
}): Promise<number> {
  const { workspaceDir, groupId, workflow, provider, repoPath, gitPullTimeoutMs = 30_000, onMerge } = opts;
  let transitions = 0;

  // Find all states with a review check (e.g. toReview with check: prApproved)
  const reviewStates = Object.entries(workflow.states)
    .filter(([, s]) => s.check != null) as [string, StateConfig][];

  for (const [stateKey, state] of reviewStates) {
    if (!state.on || !state.check) continue;

    const allIssues = await provider.listIssuesByLabel(state.label);
    const issues = filterIssuesByGroup(allIssues, groupId);
    for (const issue of issues) {
      // Only process issues explicitly marked for human review.
      // review:agent → agent reviewer pipeline handles merge.
      // No routing label → treat as agent by default (safe: never auto-merge without explicit human approval).
      // review:human → human approved on provider; heartbeat handles merge transition.
      const routing = detectStepRouting(issue.labels, "review");
      if (routing !== "human") continue;

      const status = await provider.getPrStatus(issue.iid);

      // PR_APPROVED: Accept both explicit approval and manual merge (merge = implicit approval).
      // PR_MERGED: Only triggers on merge. This prevents self-merged PRs (no reviews) from
      // bypassing the review:human gate — a developer merging their own PR must not pass as approved.
      const conditionMet =
        (state.check === ReviewCheck.PR_MERGED && status.state === PrState.MERGED) ||
        (state.check === ReviewCheck.PR_APPROVED && (status.state === PrState.APPROVED || status.state === PrState.MERGED));

      if (!conditionMet) continue;

      // Find the success transition — use the APPROVED event (matches check condition)
      const successEvent = Object.keys(state.on).find(
        (e) => e === WorkflowEvent.APPROVED,
      );
      if (!successEvent) continue;

      const transition = state.on[successEvent];
      const targetKey = typeof transition === "string" ? transition : transition.target;
      const actions = typeof transition === "object" ? transition.actions : undefined;
      const targetState = workflow.states[targetKey];
      if (!targetState) continue;

      // Execute transition actions — mergePr is critical (aborts on failure)
      let aborted = false;
      if (actions) {
        for (const action of actions) {
          switch (action) {
            case Action.MERGE_PR:
              // If the PR is already merged externally, skip the merge call but continue the transition.
              if (status.state === PrState.MERGED) {
                onMerge?.(issue.iid, status.url, status.title, status.sourceBranch);
                break;
              }
              try {
                await provider.mergePr(issue.iid);
                onMerge?.(issue.iid, status.url, status.title, status.sourceBranch);
              } catch (err) {
                // Merge failed → fire MERGE_FAILED transition (developer fixes conflicts)
                await auditLog(workspaceDir, "review_merge_failed", {
                  groupId,
                  issueId: issue.iid,
                  from: state.label,
                  error: (err as Error).message ?? String(err),
                });
                const failedTransition = state.on[WorkflowEvent.MERGE_FAILED];
                if (failedTransition) {
                  const failedKey = typeof failedTransition === "string" ? failedTransition : failedTransition.target;
                  const failedState = workflow.states[failedKey];
                  if (failedState) {
                    await provider.transitionLabel(issue.iid, state.label, failedState.label);
                    await auditLog(workspaceDir, "review_transition", {
                      groupId,
                      issueId: issue.iid,
                      from: state.label,
                      to: failedState.label,
                      reason: "merge_failed",
                    });
                    transitions++;
                  }
                }
                aborted = true;
              }
              break;
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
          if (aborted) break;
        }
      }

      if (aborted) continue; // skip normal transition, move to next issue

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
