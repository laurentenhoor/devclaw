/**
 * acknowledge.ts — Comment acknowledgement (mark consumed comments with eyes emoji).
 */
import type { IssueProvider, IssueComment } from "../providers/provider.js";
import { log as auditLog } from "../audit.js";
import type { PrFeedback } from "./pr-context.js";

// ---------------------------------------------------------------------------
// Comment acknowledgement — mark consumed comments with 👀
// ---------------------------------------------------------------------------

export const EYES_EMOJI = "eyes";

/**
 * Mark all consumed comments (issue + PR review) with 👀 so they're
 * recognized as "seen" on subsequent passes.
 *
 * Per v1.4.0 behavior:
 * - Only marks comments that don't already have 👀 (idempotent)
 * - Distinguishes between review-level and comment-level reactions for GitHub
 * - Works consistently across GitHub and GitLab
 *
 * Best-effort with error logging — never throws.
 */
export async function acknowledgeComments(
  provider: IssueProvider,
  issueId: number,
  comments: IssueComment[],
  prFeedback?: PrFeedback,
  workspaceDir?: string,
): Promise<void> {
  // Issue comments — mark as seen
  for (const c of comments) {
    try {
      // Skip if already marked
      if (await provider.issueCommentHasReaction(issueId, c.id, EYES_EMOJI)) {
        continue;
      }
      await provider.reactToIssueComment(issueId, c.id, EYES_EMOJI);
    } catch (err) {
      // Log error for audit trail but continue marking other comments
      if (workspaceDir) {
        auditLog(workspaceDir, "comment_marking_error", {
          step: "markIssueComment",
          issue: issueId,
          commentId: c.id,
          error: (err as Error).message ?? String(err),
        }).catch(() => {});
      }
    }
  }

  // PR review comments (from feedback context)
  if (prFeedback) {
    for (const c of prFeedback.comments) {
      try {
        // Skip if already marked
        if (c.path) {
          // Inline comment → use prCommentHasReaction
          if (await provider.prCommentHasReaction(issueId, c.id, EYES_EMOJI)) {
            continue;
          }
          await provider.reactToPrComment(issueId, c.id, EYES_EMOJI);
        } else {
          // Determine if this is a review-level comment or a regular comment
          // For GitHub: APPROVED/CHANGES_REQUESTED are always review-level
          // For GitLab: all are treated the same (reactToPrReview calls reactToPrComment)
          if (c.state === "APPROVED" || c.state === "CHANGES_REQUESTED") {
            // Review-level comment → check review API
            if (await provider.prReviewHasReaction(issueId, c.id, EYES_EMOJI)) {
              continue;
            }
            await provider.reactToPrReview(issueId, c.id, EYES_EMOJI);
          } else {
            // COMMENTED/INLINE/UNRESOLVED/RESOLVED → comment-level
            if (await provider.prCommentHasReaction(issueId, c.id, EYES_EMOJI)) {
              continue;
            }
            await provider.reactToPrComment(issueId, c.id, EYES_EMOJI);
          }
        }
      } catch (err) {
        // Log error for audit trail but continue marking other comments
        if (workspaceDir) {
          auditLog(workspaceDir, "comment_marking_error", {
            step: "markPrComment",
            issue: issueId,
            commentId: c.id,
            state: c.state,
            error: (err as Error).message ?? String(err),
          }).catch(() => {});
        }
      }
    }
  }
}
