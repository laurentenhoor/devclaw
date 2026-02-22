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
  projectName: string;
  workflow: WorkflowConfig;
  provider: IssueProvider;
  repoPath: string;
  gitPullTimeoutMs?: number;
  /** Base branch used for git history fallback check (e.g. "main"). */
  baseBranch?: string;
  /** Called after a successful PR merge (for notifications). */
  onMerge?: (issueId: number, prUrl: string | null, prTitle?: string, sourceBranch?: string) => void;
  /** Called when changes are requested or conflicts detected (for notifications). */
  onFeedback?: (issueId: number, reason: "changes_requested" | "merge_conflict", prUrl: string | null, issueTitle: string, issueUrl: string) => void;
  /** Called when a PR is closed without merging (for notifications). */
  onPrClosed?: (issueId: number, prUrl: string | null, issueTitle: string, issueUrl: string) => void;
}): Promise<number> {
  const { workspaceDir, projectName, workflow, provider, repoPath, gitPullTimeoutMs = 30_000, baseBranch, onMerge, onFeedback, onPrClosed } = opts;
  let transitions = 0;

  // Find all states with a review check (e.g. toReview with check: prApproved)
  const reviewStates = Object.entries(workflow.states)
    .filter(([, s]) => s.check != null) as [string, StateConfig][];

  for (const [stateKey, state] of reviewStates) {
    if (!state.on || !state.check) continue;

    const issues = await provider.listIssuesByLabel(state.label);
    for (const issue of issues) {
      // Only process issues explicitly marked for human review.
      // review:agent → agent reviewer pipeline handles merge.
      // No routing label → treat as agent by default (safe: never auto-merge without explicit human approval).
      // review:human → human approved on provider; heartbeat handles merge transition.
      const routing = detectStepRouting(issue.labels, "review");
      if (routing !== "human") continue;

      // Only process issues managed by DevClaw (marked with 👀 on issue body).
      // Old-style issues without the marker are skipped to prevent false triggers
      // from historical comments.
      const isManaged = await provider.issueHasReaction(issue.iid, "eyes");
      if (!isManaged) continue;

      const status = await provider.getPrStatus(issue.iid);

      // Fallback: no PR found, but work may have been committed directly to base branch.
      // Check git history for commits mentioning this issue number.
      if (!status.url && status.state === PrState.CLOSED && baseBranch) {
        try {
          const isOnBranch = await provider.isCommitOnBaseBranch(issue.iid, baseBranch);
          if (isOnBranch) {
            status.state = PrState.MERGED;
            await auditLog(workspaceDir, "review_git_fallback", {
              project: projectName, issueId: issue.iid,
              reason: "commit_on_base_branch",
              baseBranch,
            });
          }
        } catch { /* best-effort — don't block on git failure */ }
      }

      // PR_APPROVED: Accept both explicit approval and manual merge (merge = implicit approval).
      // PR_MERGED: Only triggers on merge. This prevents self-merged PRs (no reviews) from
      // bypassing the review:human gate — a developer merging their own PR must not pass as approved.
      const conditionMet =
        (state.check === ReviewCheck.PR_MERGED && status.state === PrState.MERGED) ||
        (state.check === ReviewCheck.PR_APPROVED && (status.state === PrState.APPROVED || status.state === PrState.MERGED));

      // Changes requested or PR has comment feedback → transition to toImprove
      if (status.state === PrState.CHANGES_REQUESTED || status.state === PrState.HAS_COMMENTS) {
        const changesTransition = state.on[WorkflowEvent.CHANGES_REQUESTED];
        if (changesTransition) {
          const targetKey = typeof changesTransition === "string" ? changesTransition : changesTransition.target;
          const targetState = workflow.states[targetKey];
          if (targetState) {
            await provider.transitionLabel(issue.iid, state.label, targetState.label);
            await auditLog(workspaceDir, "review_transition", {
              project: projectName, issueId: issue.iid,
              from: state.label, to: targetState.label,
              reason: status.state === PrState.HAS_COMMENTS ? "pr_comments" : "changes_requested",
              prUrl: status.url,
            });
            onFeedback?.(issue.iid, "changes_requested", status.url, issue.title, issue.web_url);
            // React to each review comment with 🤖 to acknowledge processing (best-effort)
            reactToFeedbackComments(provider, issue.iid).catch(() => {});
            transitions++;
            continue;
          }
        }
      }

      // Merge conflict → transition to toImprove
      if (status.mergeable === false) {
        const conflictTransition = state.on[WorkflowEvent.MERGE_CONFLICT];
        if (conflictTransition) {
          const targetKey = typeof conflictTransition === "string" ? conflictTransition : conflictTransition.target;
          const targetState = workflow.states[targetKey];
          if (targetState) {
            await provider.transitionLabel(issue.iid, state.label, targetState.label);
            await auditLog(workspaceDir, "review_transition", {
              project: projectName, issueId: issue.iid,
              from: state.label, to: targetState.label,
              reason: "merge_conflict",
              prUrl: status.url,
            });
            onFeedback?.(issue.iid, "merge_conflict", status.url, issue.title, issue.web_url);
            transitions++;
            continue;
          }
        }
      }

      // PR closed without merging → execute configured transition + actions
      // status.url non-null distinguishes "PR was explicitly closed" from "no PR exists"
      if (status.state === PrState.CLOSED && status.url !== null) {
        const closedTransition = state.on[WorkflowEvent.PR_CLOSED];
        if (closedTransition) {
          const targetKey = typeof closedTransition === "string" ? closedTransition : closedTransition.target;
          const closedActions = typeof closedTransition === "object" ? closedTransition.actions : undefined;
          const targetState = workflow.states[targetKey];
          if (targetState) {
            await provider.transitionLabel(issue.iid, state.label, targetState.label);
            if (closedActions) {
              for (const action of closedActions) {
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
            await auditLog(workspaceDir, "review_transition", {
              project: projectName, issueId: issue.iid,
              from: state.label, to: targetState.label,
              reason: "pr_closed",
              prUrl: status.url,
              actions: closedActions,
            });
            onPrClosed?.(issue.iid, status.url, issue.title, issue.web_url);
            transitions++;
            continue;
          }
        }
      }

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
                  project: projectName,
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
                      project: projectName,
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
        project: projectName,
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reaction emoji used to acknowledge PR feedback has been noticed. */
const FEEDBACK_REACTION_EMOJI = "eyes";

/**
 * Add a 🤖 reaction to all PR review comments on the issue's PR.
 * Best-effort: errors are swallowed by the caller (.catch(() => {})).
 */
async function reactToFeedbackComments(
  provider: IssueProvider,
  issueId: number,
): Promise<void> {
  const comments = await provider.getPrReviewComments(issueId);
  for (const comment of comments) {
    // Reviews (APPROVED, CHANGES_REQUESTED, COMMENTED) use a different reaction API
    // than issue/inline comments. Route accordingly.
    if (comment.state === "APPROVED" || comment.state === "CHANGES_REQUESTED" || comment.state === "COMMENTED") {
      await provider.reactToPrReview(issueId, comment.id, FEEDBACK_REACTION_EMOJI);
    } else {
      await provider.reactToPrComment(issueId, comment.id, FEEDBACK_REACTION_EMOJI);
    }
  }
}
