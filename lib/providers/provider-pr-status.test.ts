/**
 * Tests for getPrStatus() — distinguishing closed-PR from no-PR-exists.
 *
 * Issue #315: getPrStatus must return a non-null url for explicitly closed PRs
 * so callers can distinguish "PR was closed without merging" vs "no PR exists".
 *
 * Run with: npx tsx --test lib/providers/provider-pr-status.test.ts
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert";
import type { RunCommand } from "../context.js";
import { GitHubProvider } from "./github.js";
import { GitLabProvider } from "./gitlab.js";
import { PrState } from "./provider.js";

/** Noop runCommand for tests that mock all provider methods anyway. */
const mockRunCommand: RunCommand = async () => ({
  stdout: "", stderr: "", exitCode: 0, code: 0, signal: null, killed: false, termination: "exit",
} as any);

// ---------------------------------------------------------------------------
// GitHub provider tests
// ---------------------------------------------------------------------------

describe("GitHubProvider.getPrStatus — closed PR handling", () => {
  it("returns url:null when no PR has ever been created", async () => {
    const provider = new GitHubProvider({ repoPath: "/fake", runCommand: mockRunCommand });

    // findPrsForIssue returns [] for open and merged, findPrsViaTimeline returns null (GraphQL unavailable)
    (provider as any).findPrsForIssue = async () => [];
    (provider as any).findPrsViaTimeline = async () => null;

    const status = await provider.getPrStatus(42);

    assert.strictEqual(status.state, PrState.CLOSED);
    assert.strictEqual(status.url, null, "no PR exists → url must be null");
  });

  it("returns url:null when timeline returns empty array (no PRs at all)", async () => {
    const provider = new GitHubProvider({ repoPath: "/fake", runCommand: mockRunCommand });

    (provider as any).findPrsForIssue = async () => [];
    (provider as any).findPrsViaTimeline = async () => [];

    const status = await provider.getPrStatus(42);

    assert.strictEqual(status.state, PrState.CLOSED);
    assert.strictEqual(status.url, null, "empty timeline → url must be null");
  });

  it("returns url:closedPrUrl when a closed-without-merge PR exists", async () => {
    const provider = new GitHubProvider({ repoPath: "/fake", runCommand: mockRunCommand });

    const closedPrUrl = "https://github.com/owner/repo/pull/7";

    (provider as any).findPrsForIssue = async (_id: number, state: string) => {
      if (state === "open" || state === "merged") return [];
      return [];
    };
    (provider as any).findPrsViaTimeline = async (_id: number, state: string) => {
      if (state === "all") {
        return [
          {
            number: 7,
            title: "feat: some work",
            body: "",
            headRefName: "feature/7-some-work",
            url: closedPrUrl,
            mergedAt: null,
            reviewDecision: null,
            state: "CLOSED",
          },
        ];
      }
      return [];
    };

    const status = await provider.getPrStatus(42);

    assert.strictEqual(status.state, PrState.CLOSED);
    assert.strictEqual(status.url, closedPrUrl, "closed PR → url must be the closed PR url");
    assert.strictEqual(status.sourceBranch, "feature/7-some-work");
  });

  it("prefers open PR over closed PR", async () => {
    const provider = new GitHubProvider({ repoPath: "/fake", runCommand: mockRunCommand });

    const openPrUrl = "https://github.com/owner/repo/pull/9";

    (provider as any).findPrsForIssue = async (_id: number, state: string) => {
      if (state === "open") {
        return [
          {
            title: "feat: open pr",
            body: "",
            headRefName: "feature/9-open-pr",
            url: openPrUrl,
            number: 9,
            reviewDecision: "",
            mergeable: "MERGEABLE",
          },
        ];
      }
      return [];
    };
    // Simulate no changes-requested reviews and no comments
    (provider as any).hasChangesRequestedReview = async () => false;
    (provider as any).hasUnacknowledgedReviews = async () => false;
    (provider as any).hasConversationComments = async () => false;

    const status = await provider.getPrStatus(42);

    assert.strictEqual(status.state, PrState.OPEN);
    assert.strictEqual(status.url, openPrUrl);
  });

  it("prefers merged PR over closed PR", async () => {
    const provider = new GitHubProvider({ repoPath: "/fake", runCommand: mockRunCommand });

    const mergedPrUrl = "https://github.com/owner/repo/pull/5";

    (provider as any).findPrsForIssue = async (_id: number, state: string) => {
      if (state === "open") return [];
      if (state === "merged") {
        return [
          {
            title: "feat: merged",
            body: "",
            headRefName: "feature/5-merged",
            url: mergedPrUrl,
            reviewDecision: null,
          },
        ];
      }
      return [];
    };
    (provider as any).findPrsViaTimeline = async () => null;

    const status = await provider.getPrStatus(42);

    assert.strictEqual(status.state, PrState.MERGED);
    assert.strictEqual(status.url, mergedPrUrl);
  });

  it("ignores non-CLOSED states in timeline when returning closed PR", async () => {
    const provider = new GitHubProvider({ repoPath: "/fake", runCommand: mockRunCommand });

    (provider as any).findPrsForIssue = async () => [];
    // Timeline has only OPEN PRs — none should trigger closed-PR path
    (provider as any).findPrsViaTimeline = async (_id: number, state: string) => {
      if (state === "all") {
        return [{ number: 10, title: "", body: "", headRefName: "", url: "https://github.com/owner/repo/pull/10", mergedAt: null, reviewDecision: null, state: "OPEN", mergeable: null }];
      }
      return [];
    };

    const status = await provider.getPrStatus(42);

    // OPEN PR in timeline but findPrsForIssue("open") returned [] → shouldn't reach here normally,
    // but the CLOSED fallback path should not pick it up.
    assert.strictEqual(status.state, PrState.CLOSED);
    assert.strictEqual(status.url, null, "OPEN state in timeline should not match closed-PR path");
  });

  it("detects merge conflicts via mergeable field", async () => {
    const provider = new GitHubProvider({ repoPath: "/fake", runCommand: mockRunCommand });

    const conflictedPrUrl = "https://github.com/owner/repo/pull/11";

    (provider as any).findPrsForIssue = async (_id: number, state: string) => {
      if (state === "open") {
        return [
          {
            title: "feat: conflicted pr",
            body: "",
            headRefName: "feature/11-conflicted",
            url: conflictedPrUrl,
            number: 11,
            reviewDecision: "",
            mergeable: "CONFLICTING",
          },
        ];
      }
      return [];
    };
    // Simulate no changes-requested reviews and no comments
    (provider as any).hasChangesRequestedReview = async () => false;
    (provider as any).hasUnacknowledgedReviews = async () => false;
    (provider as any).hasConversationComments = async () => false;

    const status = await provider.getPrStatus(42);

    assert.strictEqual(status.state, PrState.OPEN);
    assert.strictEqual(status.url, conflictedPrUrl);
    assert.strictEqual(status.mergeable, false, "mergeable: CONFLICTING should be detected as false");
  });

  it("distinguishes mergeable states", async () => {
    const provider = new GitHubProvider({ repoPath: "/fake", runCommand: mockRunCommand });

    const mergeablePrUrl = "https://github.com/owner/repo/pull/12";

    (provider as any).findPrsForIssue = async (_id: number, state: string) => {
      if (state === "open") {
        return [
          {
            title: "feat: clean pr",
            body: "",
            headRefName: "feature/12-clean",
            url: mergeablePrUrl,
            number: 12,
            reviewDecision: "",
            mergeable: "MERGEABLE",
          },
        ];
      }
      return [];
    };
    (provider as any).hasChangesRequestedReview = async () => false;
    (provider as any).hasUnacknowledgedReviews = async () => false;
    (provider as any).hasConversationComments = async () => false;

    const status = await provider.getPrStatus(42);

    assert.strictEqual(status.state, PrState.OPEN);
    assert.strictEqual(status.url, mergeablePrUrl);
    assert.strictEqual(status.mergeable, true, "mergeable: MERGEABLE should be detected as true");
  });

  it("handles unknown mergeable state", async () => {
    const provider = new GitHubProvider({ repoPath: "/fake", runCommand: mockRunCommand });

    const unknownPrUrl = "https://github.com/owner/repo/pull/13";

    (provider as any).findPrsForIssue = async (_id: number, state: string) => {
      if (state === "open") {
        return [
          {
            title: "feat: unknown state pr",
            body: "",
            headRefName: "feature/13-unknown",
            url: unknownPrUrl,
            number: 13,
            reviewDecision: "",
            mergeable: "UNKNOWN",
          },
        ];
      }
      return [];
    };
    (provider as any).hasChangesRequestedReview = async () => false;
    (provider as any).hasUnacknowledgedReviews = async () => false;
    (provider as any).hasConversationComments = async () => false;

    const status = await provider.getPrStatus(42);

    assert.strictEqual(status.state, PrState.OPEN);
    assert.strictEqual(status.url, unknownPrUrl);
    assert.strictEqual(status.mergeable, undefined, "mergeable: UNKNOWN should remain undefined (no assumption)");
  });
});

// ---------------------------------------------------------------------------
// GitLab provider tests
// ---------------------------------------------------------------------------

describe("GitLabProvider.getPrStatus — closed MR handling", () => {
  it("returns url:null when no MR has ever been created", async () => {
    const provider = new GitLabProvider({ repoPath: "/fake", runCommand: mockRunCommand });

    (provider as any).getRelatedMRs = async () => [];

    const status = await provider.getPrStatus(42);

    assert.strictEqual(status.state, PrState.CLOSED);
    assert.strictEqual(status.url, null, "no MR exists → url must be null");
  });

  it("returns url:closedMrUrl when a closed-without-merge MR exists", async () => {
    const provider = new GitLabProvider({ repoPath: "/fake", runCommand: mockRunCommand });

    const closedMrUrl = "https://gitlab.com/owner/repo/-/merge_requests/3";

    (provider as any).getRelatedMRs = async () => [
      {
        iid: 3,
        title: "feat: some work",
        description: "",
        web_url: closedMrUrl,
        state: "closed",
        source_branch: "feature/3-some-work",
        merged_at: null,
      },
    ];

    const status = await provider.getPrStatus(42);

    assert.strictEqual(status.state, PrState.CLOSED);
    assert.strictEqual(status.url, closedMrUrl, "closed MR → url must be the closed MR url");
    assert.strictEqual(status.sourceBranch, "feature/3-some-work");
  });

  it("prefers open MR over closed MR", async () => {
    const provider = new GitLabProvider({ repoPath: "/fake", runCommand: mockRunCommand });

    const openMrUrl = "https://gitlab.com/owner/repo/-/merge_requests/4";
    const closedMrUrl = "https://gitlab.com/owner/repo/-/merge_requests/2";

    (provider as any).getRelatedMRs = async () => [
      { iid: 4, title: "open MR", description: "", web_url: openMrUrl, state: "opened", source_branch: "feature/4", merged_at: null },
      { iid: 2, title: "closed MR", description: "", web_url: closedMrUrl, state: "closed", source_branch: "feature/2", merged_at: null },
    ];
    (provider as any).isMrApproved = async () => false;
    (provider as any).hasUnresolvedDiscussions = async () => false;
    (provider as any).hasConversationComments = async () => false;
    (provider as any).isMrMergeable = async () => true;

    const status = await provider.getPrStatus(42);

    assert.strictEqual(status.state, PrState.OPEN);
    assert.strictEqual(status.url, openMrUrl);
  });

  it("prefers merged MR over closed MR", async () => {
    const provider = new GitLabProvider({ repoPath: "/fake", runCommand: mockRunCommand });

    const mergedMrUrl = "https://gitlab.com/owner/repo/-/merge_requests/5";
    const closedMrUrl = "https://gitlab.com/owner/repo/-/merge_requests/1";

    (provider as any).getRelatedMRs = async () => [
      { iid: 5, title: "merged", description: "", web_url: mergedMrUrl, state: "merged", source_branch: "feature/5", merged_at: "2026-01-01T00:00:00Z" },
      { iid: 1, title: "closed", description: "", web_url: closedMrUrl, state: "closed", source_branch: "feature/1", merged_at: null },
    ];

    const status = await provider.getPrStatus(42);

    assert.strictEqual(status.state, PrState.MERGED);
    assert.strictEqual(status.url, mergedMrUrl);
  });

  it("handles multiple closed MRs — returns the first found", async () => {
    const provider = new GitLabProvider({ repoPath: "/fake", runCommand: mockRunCommand });

    const closedMrUrl1 = "https://gitlab.com/owner/repo/-/merge_requests/10";
    const closedMrUrl2 = "https://gitlab.com/owner/repo/-/merge_requests/11";

    (provider as any).getRelatedMRs = async () => [
      { iid: 10, title: "closed 1", description: "", web_url: closedMrUrl1, state: "closed", source_branch: "feature/10", merged_at: null },
      { iid: 11, title: "closed 2", description: "", web_url: closedMrUrl2, state: "closed", source_branch: "feature/11", merged_at: null },
    ];

    const status = await provider.getPrStatus(42);

    assert.strictEqual(status.state, PrState.CLOSED);
    // First closed MR found is returned
    assert.strictEqual(status.url, closedMrUrl1);
  });
});
