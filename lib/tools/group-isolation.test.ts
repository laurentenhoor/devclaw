/**
 * Tests for multi-group isolation via notify:{groupId} labels.
 *
 * Covers:
 * - filterIssuesByGroup: group-owned, foreign, orphan
 * - getNotifyLabel / NOTIFY_LABEL_PREFIX / NOTIFY_LABEL_COLOR
 * - findNextIssueForRole with groupId filter
 * - reviewPass with groupId filter
 * - Backward compatibility: orphan issues visible to all groups
 *
 * Run with: npx tsx --test lib/tools/group-isolation.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import {
  filterIssuesByGroup,
  getNotifyLabel,
  NOTIFY_LABEL_PREFIX,
  NOTIFY_LABEL_COLOR,
  DEFAULT_WORKFLOW,
} from "../workflow.js";
import { findNextIssueForRole, findNextIssue } from "../services/queue-scan.js";
import { reviewPass } from "../services/review.js";
import { createTestHarness, type TestHarness } from "../testing/index.js";

// ---------------------------------------------------------------------------
// filterIssuesByGroup — unit tests
// ---------------------------------------------------------------------------

describe("filterIssuesByGroup", () => {
  const GROUP_A = "-100000001";
  const GROUP_B = "-200000002";

  const makeIssue = (id: number, labels: string[]) => ({
    iid: id, title: `Issue #${id}`, description: "", labels, state: "open",
    web_url: `https://example.com/issues/${id}`,
  });

  it("should include issues tagged for the current group", () => {
    const issues = [makeIssue(1, ["To Do", `notify:${GROUP_A}`])];
    const result = filterIssuesByGroup(issues, GROUP_A);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].iid, 1);
  });

  it("should exclude issues tagged for a different group", () => {
    const issues = [makeIssue(2, ["To Do", `notify:${GROUP_B}`])];
    const result = filterIssuesByGroup(issues, GROUP_A);
    assert.strictEqual(result.length, 0);
  });

  it("should include orphan issues (no notify label) for any group", () => {
    const issues = [makeIssue(3, ["To Do"])];
    const resultA = filterIssuesByGroup(issues, GROUP_A);
    const resultB = filterIssuesByGroup(issues, GROUP_B);
    assert.strictEqual(resultA.length, 1, "Group A should see orphan");
    assert.strictEqual(resultB.length, 1, "Group B should see orphan");
  });

  it("should handle mixed list: own + foreign + orphan", () => {
    const issues = [
      makeIssue(10, ["To Do", `notify:${GROUP_A}`]),  // mine
      makeIssue(11, ["To Do", `notify:${GROUP_B}`]),  // foreign
      makeIssue(12, ["To Do"]),                        // orphan
    ];
    const result = filterIssuesByGroup(issues, GROUP_A);
    assert.strictEqual(result.length, 2);
    const ids = result.map(i => i.iid);
    assert.ok(ids.includes(10), "should include own issue");
    assert.ok(!ids.includes(11), "should exclude foreign issue");
    assert.ok(ids.includes(12), "should include orphan");
  });

  it("should return empty array when all issues are foreign", () => {
    const issues = [
      makeIssue(20, [`notify:${GROUP_B}`]),
      makeIssue(21, [`notify:${GROUP_B}`]),
    ];
    const result = filterIssuesByGroup(issues, GROUP_A);
    assert.strictEqual(result.length, 0);
  });

  it("should handle empty input", () => {
    assert.deepStrictEqual(filterIssuesByGroup([], GROUP_A), []);
  });

  it("should be case-sensitive for label matching", () => {
    const issues = [makeIssue(30, ["To Do", "Notify:-100000001"])]; // wrong case
    const result = filterIssuesByGroup(issues, GROUP_A);
    // "Notify:" doesn't start with lowercase "notify:" → treated as orphan (no notify label detected)
    assert.strictEqual(result.length, 1, "uppercase Notify: should be treated as orphan (no match)");
  });
});

// ---------------------------------------------------------------------------
// getNotifyLabel / constants
// ---------------------------------------------------------------------------

describe("notify label helpers", () => {
  it("should build notify label from groupId", () => {
    assert.strictEqual(getNotifyLabel("-5176490302"), "notify:-5176490302");
    assert.strictEqual(getNotifyLabel("-1003843401024"), "notify:-1003843401024");
  });

  it("NOTIFY_LABEL_PREFIX should be 'notify:'", () => {
    assert.strictEqual(NOTIFY_LABEL_PREFIX, "notify:");
  });

  it("NOTIFY_LABEL_COLOR should be light grey", () => {
    assert.strictEqual(NOTIFY_LABEL_COLOR, "#e4e4e4");
  });

  it("getNotifyLabel output should start with NOTIFY_LABEL_PREFIX", () => {
    const label = getNotifyLabel("-999");
    assert.ok(label.startsWith(NOTIFY_LABEL_PREFIX));
  });
});

// ---------------------------------------------------------------------------
// findNextIssueForRole with groupId filter
// ---------------------------------------------------------------------------

describe("findNextIssueForRole — group isolation", () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await createTestHarness();
  });

  it("should return issue tagged for current group", async () => {
    h.provider.seedIssue({ iid: 1, title: "Group A issue", labels: ["To Do", "notify:-111"] });
    const result = await findNextIssueForRole(h.provider, "developer", DEFAULT_WORKFLOW, "-111");
    assert.ok(result, "should find issue");
    assert.strictEqual(result!.issue.iid, 1);
  });

  it("should NOT return issue tagged for different group", async () => {
    h.provider.seedIssue({ iid: 2, title: "Group B issue", labels: ["To Do", "notify:-222"] });
    const result = await findNextIssueForRole(h.provider, "developer", DEFAULT_WORKFLOW, "-111");
    assert.strictEqual(result, null, "should not return foreign issue");
  });

  it("should return orphan issue (backward compat)", async () => {
    h.provider.seedIssue({ iid: 3, title: "Orphan issue", labels: ["To Do"] });
    const result = await findNextIssueForRole(h.provider, "developer", DEFAULT_WORKFLOW, "-111");
    assert.ok(result, "orphan should be visible");
    assert.strictEqual(result!.issue.iid, 3);
  });

  it("should work without groupId (no filtering)", async () => {
    h.provider.seedIssue({ iid: 4, title: "Issue", labels: ["To Do", "notify:-999"] });
    const result = await findNextIssueForRole(h.provider, "developer", DEFAULT_WORKFLOW);
    assert.ok(result, "should find issue when no groupId filter");
  });

  it("parallel groups: Group A gets own issue, Group B gets nothing", async () => {
    h.provider.seedIssue({ iid: 10, title: "Group A work", labels: ["To Do", "notify:-111"] });

    const resultA = await findNextIssueForRole(h.provider, "developer", DEFAULT_WORKFLOW, "-111");
    const resultB = await findNextIssueForRole(h.provider, "developer", DEFAULT_WORKFLOW, "-222");

    assert.ok(resultA, "Group A should find its issue");
    assert.strictEqual(resultA!.issue.iid, 10);
    assert.strictEqual(resultB, null, "Group B should not find Group A's issue");
  });
});

// ---------------------------------------------------------------------------
// findNextIssue (auto-detect) with groupId filter
// ---------------------------------------------------------------------------

describe("findNextIssue — group isolation", () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await createTestHarness();
  });

  it("should filter by group when groupId provided", async () => {
    h.provider.seedIssue({ iid: 1, title: "Mine", labels: ["To Do", "notify:-AAA"] });
    h.provider.seedIssue({ iid: 2, title: "Theirs", labels: ["To Do", "notify:-BBB"] });

    const result = await findNextIssue(h.provider, "developer", DEFAULT_WORKFLOW, "-AAA");
    assert.ok(result, "should find issue");
    assert.strictEqual(result!.issue.iid, 1);
  });

  it("should NOT return foreign issue", async () => {
    h.provider.seedIssue({ iid: 1, title: "Theirs", labels: ["To Do", "notify:-BBB"] });

    const result = await findNextIssue(h.provider, "developer", DEFAULT_WORKFLOW, "-AAA");
    assert.strictEqual(result, null);
  });
});

// ---------------------------------------------------------------------------
// reviewPass — group isolation
// ---------------------------------------------------------------------------

describe("reviewPass — group isolation", () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await createTestHarness();
  });

  it("should process review:human issue tagged for current group", async () => {
    h.provider.seedIssue({
      iid: 50, title: "Group A review",
      labels: ["To Review", "review:human", "notify:-AAA"],
    });
    h.provider.setPrStatus(50, { state: "approved", url: "https://example.com/pr/50" });

    const transitions = await reviewPass({
      workspaceDir: h.workspaceDir,
      groupId: "-AAA",
      workflow: DEFAULT_WORKFLOW,
      provider: h.provider,
      repoPath: "/tmp/test",
    });

    assert.strictEqual(transitions, 1, "should transition Group A's issue");
    const issue = await h.provider.getIssue(50);
    assert.ok(issue.labels.includes("To Test"), `Labels: ${issue.labels}`);
  });

  it("should NOT process review:human issue tagged for different group", async () => {
    h.provider.seedIssue({
      iid: 51, title: "Group B review",
      labels: ["To Review", "review:human", "notify:-BBB"],
    });
    h.provider.setPrStatus(51, { state: "approved", url: "https://example.com/pr/51" });

    const transitions = await reviewPass({
      workspaceDir: h.workspaceDir,
      groupId: "-AAA",
      workflow: DEFAULT_WORKFLOW,
      provider: h.provider,
      repoPath: "/tmp/test",
    });

    assert.strictEqual(transitions, 0, "should not touch Group B's issue");
    const issue = await h.provider.getIssue(51);
    assert.ok(issue.labels.includes("To Review"), "should remain in To Review");
  });

  it("should process orphan review:human issue (backward compat)", async () => {
    h.provider.seedIssue({
      iid: 52, title: "Orphan review",
      labels: ["To Review", "review:human"],  // no notify label
    });
    h.provider.setPrStatus(52, { state: "approved", url: "https://example.com/pr/52" });

    const transitions = await reviewPass({
      workspaceDir: h.workspaceDir,
      groupId: "-AAA",
      workflow: DEFAULT_WORKFLOW,
      provider: h.provider,
      repoPath: "/tmp/test",
    });

    assert.strictEqual(transitions, 1, "orphan should be processed for backward compat");
  });

  it("parallel groups: only correct group processes its review issue", async () => {
    h.provider.seedIssue({
      iid: 60, title: "Group A review",
      labels: ["To Review", "review:human", "notify:-AAA"],
    });
    h.provider.seedIssue({
      iid: 61, title: "Group B review",
      labels: ["To Review", "review:human", "notify:-BBB"],
    });
    h.provider.setPrStatus(60, { state: "approved", url: "https://example.com/pr/60" });
    h.provider.setPrStatus(61, { state: "approved", url: "https://example.com/pr/61" });

    const transA = await reviewPass({
      workspaceDir: h.workspaceDir,
      groupId: "-AAA",
      workflow: DEFAULT_WORKFLOW,
      provider: h.provider,
      repoPath: "/tmp/test",
    });

    assert.strictEqual(transA, 1, "Group A should only process its own issue");

    const issue60 = await h.provider.getIssue(60);
    const issue61 = await h.provider.getIssue(61);
    assert.ok(issue60.labels.includes("To Test"), "Group A's issue should advance");
    assert.ok(issue61.labels.includes("To Review"), "Group B's issue should stay");
  });
});
