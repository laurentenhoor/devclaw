import { describe, it, expect } from "vitest";
import { formatPrFeedback, type PrFeedback } from "./pr-context.js";

describe("formatPrFeedback", () => {
  it("returns empty array when no comments", () => {
    const feedback: PrFeedback = {
      url: "https://github.com/user/repo/pull/123",
      branchName: "feature/123-test",
      reason: "merge_conflict",
      comments: [],
    };
    const result = formatPrFeedback(feedback, "main");
    expect(result).toEqual([]);
  });

  it("includes branch name in conflict resolution instructions", () => {
    const feedback: PrFeedback = {
      url: "https://github.com/user/repo/pull/123",
      branchName: "feature/456-test",
      reason: "merge_conflict",
      comments: [
        {
          id: 1,
          author: "reviewer",
          body: "Conflicts detected",
          state: "COMMENTED",
        },
      ],
    };
    const result = formatPrFeedback(feedback, "main");
    const text = result.join("\n");

    expect(text).toContain("feature/456-test");
    expect(text).toContain("🔹 Branch: `feature/456-test`");
    expect(text).toContain("git checkout feature/456-test");
    expect(text).toContain("git push --force-with-lease origin feature/456-test");
  });

  it("uses fallback branch name when not provided", () => {
    const feedback: PrFeedback = {
      url: "https://github.com/user/repo/pull/123",
      reason: "merge_conflict",
      comments: [
        {
          id: 1,
          author: "reviewer",
          body: "Conflicts detected",
          state: "COMMENTED",
        },
      ],
    };
    const result = formatPrFeedback(feedback, "main");
    const text = result.join("\n");

    expect(text).toContain("your-branch");
    expect(text).toContain("🔹 Branch: `your-branch`");
  });

  it("includes step-by-step instructions for conflict resolution", () => {
    const feedback: PrFeedback = {
      url: "https://github.com/user/repo/pull/123",
      branchName: "feature/123-fix",
      reason: "merge_conflict",
      comments: [
        {
          id: 1,
          author: "reviewer",
          body: "Fix the conflicts",
          state: "COMMENTED",
        },
      ],
    };
    const result = formatPrFeedback(feedback, "develop");
    const text = result.join("\n");

    // Check all steps are present
    expect(text).toContain("1. Fetch and check out the PR branch");
    expect(text).toContain("2. Rebase onto `develop`");
    expect(text).toContain("3. Resolve any conflicts");
    expect(text).toContain("4. Force-push to the SAME branch");
    expect(text).toContain("5. Verify the PR shows as mergeable");

    // Check warning about not creating new PR
    expect(text).toContain("⚠️ Do NOT create a new PR");
    expect(text).toContain("Do NOT switch branches");
    expect(text).toContain("Update THIS PR only");
  });

  it("correctly formats changes_requested feedback", () => {
    const feedback: PrFeedback = {
      url: "https://github.com/user/repo/pull/456",
      branchName: "feature/789-feature",
      reason: "changes_requested",
      comments: [
        {
          id: 1,
          author: "reviewer",
          body: "Please make these changes",
          state: "CHANGES_REQUESTED",
        },
      ],
    };
    const result = formatPrFeedback(feedback, "main");
    const text = result.join("\n");

    expect(text).toContain("⚠️ Changes were requested");
    expect(text).toContain("Please make these changes");
    // Should NOT have conflict resolution instructions
    expect(text).not.toContain("Conflict Resolution Instructions");
  });

  it("includes comment location information when available", () => {
    const feedback: PrFeedback = {
      url: "https://github.com/user/repo/pull/123",
      branchName: "feature/456-test",
      reason: "changes_requested",
      comments: [
        {
          id: 1,
          author: "reviewer",
          body: "Fix this logic",
          state: "CHANGES_REQUESTED",
          path: "src/index.ts",
          line: 42,
        },
      ],
    };
    const result = formatPrFeedback(feedback, "main");
    const text = result.join("\n");

    expect(text).toContain("(src/index.ts:42)");
  });

  it("uses correct base branch in rebase command", () => {
    const feedback: PrFeedback = {
      url: "https://github.com/user/repo/pull/123",
      branchName: "feature/test",
      reason: "merge_conflict",
      comments: [
        {
          id: 1,
          author: "reviewer",
          body: "Conflicts",
          state: "COMMENTED",
        },
      ],
    };

    // Test with "main" base branch
    let result = formatPrFeedback(feedback, "main");
    let text = result.join("\n");
    expect(text).toContain("git rebase main");

    // Test with "develop" base branch
    result = formatPrFeedback(feedback, "develop");
    text = result.join("\n");
    expect(text).toContain("git rebase develop");
  });
});
