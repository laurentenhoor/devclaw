/**
 * Health service tests — orphan scan race condition and revert target.
 *
 * Tests scanOrphanedLabels with:
 * - Fresh project read (avoids stale snapshot false positives)
 * - Smart revert target based on PR status (feedback → "To Improve")
 *
 * Run: npx tsx --test lib/services/heartbeat/health.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { createTestHarness, type TestHarness } from "../../testing/index.js";
import { scanOrphanedLabels } from "./health.js";
import { PrState } from "../../providers/provider.js";
import { writeProjects, type ProjectsData } from "../../projects/index.js";

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("scanOrphanedLabels", () => {
  let h: TestHarness;

  afterEach(async () => {
    if (h) await h.cleanup();
  });

  // =========================================================================
  // Bug 1: Fresh project read eliminates false positives
  // =========================================================================

  describe("fresh project read (Bug 1)", () => {
    it("should NOT detect orphan when disk has active slot (stale snapshot is outdated)", async () => {
      // Simulate the race: heartbeat snapshot has no active developer slot,
      // but disk (projects.json) was updated by work_finish to have an active slot.
      h = await createTestHarness({
        workers: {
          // Stale snapshot: NO active slot (worker was deactivated in the snapshot)
          developer: { active: false, issueId: null, sessionKey: null },
        },
      });

      // Seed an issue with "Doing" label
      h.provider.seedIssue({ iid: 42, title: "Test issue", labels: ["Doing"] });

      // Write a fresh projects.json to disk with the slot ACTIVE
      // (simulates work_finish having activated the worker after the heartbeat snapshot)
      const freshData: ProjectsData = {
        projects: {
          [h.project.slug]: {
            ...h.project,
            workers: {
              ...h.project.workers,
              developer: {
                levels: {
                  senior: [{
                    active: true,
                    issueId: "42",
                    sessionKey: "test-session",
                    startTime: new Date().toISOString(),
                    previousLabel: null,
                  }],
                },
              },
            },
          },
        },
      };
      await writeProjects(h.workspaceDir, freshData);

      // Pass the STALE project (no active slot) — scanOrphanedLabels should
      // re-read from disk and find the active slot, avoiding the false positive.
      const fixes = await scanOrphanedLabels({
        workspaceDir: h.workspaceDir,
        projectSlug: h.project.slug,
        project: h.project, // stale: developer inactive
        role: "developer",
        autoFix: true,
        provider: h.provider,
        workflow: h.workflow,
      });

      assert.strictEqual(fixes.length, 0, "Should NOT detect orphan — disk has active slot");

      // Verify no label transition occurred
      const transitions = h.provider.callsTo("transitionLabel");
      assert.strictEqual(transitions.length, 0, "Should NOT transition any labels");
    });
  });

  // =========================================================================
  // Bug 2: Smart revert target based on PR status
  // =========================================================================

  describe("smart revert target (Bug 2)", () => {
    beforeEach(async () => {
      // All Bug 2 tests use a genuine orphan: no active slot on disk either
      h = await createTestHarness({
        workers: {
          developer: { active: false, issueId: null, sessionKey: null },
        },
      });
    });

    it("should revert to 'To Improve' when issue has open PR (feedback cycle)", async () => {
      h.provider.seedIssue({ iid: 42, title: "Test issue", labels: ["Doing"] });
      h.provider.setPrStatus(42, { state: PrState.OPEN, url: "https://github.com/test/pr/1" });

      const fixes = await scanOrphanedLabels({
        workspaceDir: h.workspaceDir,
        projectSlug: h.project.slug,
        project: h.project,
        role: "developer",
        autoFix: true,
        provider: h.provider,
        workflow: h.workflow,
      });

      assert.strictEqual(fixes.length, 1);
      assert.strictEqual(fixes[0]!.fixed, true);
      assert.strictEqual(fixes[0]!.labelReverted, "Doing → To Improve");

      // Verify issue now has "To Improve" label
      const issue = await h.provider.getIssue(42);
      assert.ok(issue.labels.includes("To Improve"), `Expected "To Improve", got: ${issue.labels}`);
    });

    it("should revert to 'To Do' when issue has no PR (fresh task)", async () => {
      h.provider.seedIssue({ iid: 42, title: "Test issue", labels: ["Doing"] });
      // No PR status set — defaults to { state: "closed", url: null }

      const fixes = await scanOrphanedLabels({
        workspaceDir: h.workspaceDir,
        projectSlug: h.project.slug,
        project: h.project,
        role: "developer",
        autoFix: true,
        provider: h.provider,
        workflow: h.workflow,
      });

      assert.strictEqual(fixes.length, 1);
      assert.strictEqual(fixes[0]!.fixed, true);
      assert.strictEqual(fixes[0]!.labelReverted, "Doing → To Do");

      // Verify issue now has "To Do" label
      const issue = await h.provider.getIssue(42);
      assert.ok(issue.labels.includes("To Do"), `Expected "To Do", got: ${issue.labels}`);
    });

    it("should revert to 'To Improve' when PR has changes_requested", async () => {
      h.provider.seedIssue({ iid: 42, title: "Test issue", labels: ["Doing"] });
      h.provider.setPrStatus(42, { state: PrState.CHANGES_REQUESTED, url: "https://github.com/test/pr/1" });

      const fixes = await scanOrphanedLabels({
        workspaceDir: h.workspaceDir,
        projectSlug: h.project.slug,
        project: h.project,
        role: "developer",
        autoFix: true,
        provider: h.provider,
        workflow: h.workflow,
      });

      assert.strictEqual(fixes.length, 1);
      assert.strictEqual(fixes[0]!.fixed, true);
      assert.strictEqual(fixes[0]!.labelReverted, "Doing → To Improve");
    });

    it("should revert to 'To Improve' when PR has comments (HAS_COMMENTS)", async () => {
      h.provider.seedIssue({ iid: 42, title: "Test issue", labels: ["Doing"] });
      h.provider.setPrStatus(42, { state: PrState.HAS_COMMENTS, url: "https://github.com/test/pr/1" });

      const fixes = await scanOrphanedLabels({
        workspaceDir: h.workspaceDir,
        projectSlug: h.project.slug,
        project: h.project,
        role: "developer",
        autoFix: true,
        provider: h.provider,
        workflow: h.workflow,
      });

      assert.strictEqual(fixes.length, 1);
      assert.strictEqual(fixes[0]!.fixed, true);
      assert.strictEqual(fixes[0]!.labelReverted, "Doing → To Improve");
    });

    it("should fall back to 'To Do' when getPrStatus throws", async () => {
      h.provider.seedIssue({ iid: 42, title: "Test issue", labels: ["Doing"] });

      // Override getPrStatus to throw (simulates API failure)
      const originalGetPrStatus = h.provider.getPrStatus.bind(h.provider);
      h.provider.getPrStatus = async () => { throw new Error("API timeout"); };

      const fixes = await scanOrphanedLabels({
        workspaceDir: h.workspaceDir,
        projectSlug: h.project.slug,
        project: h.project,
        role: "developer",
        autoFix: true,
        provider: h.provider,
        workflow: h.workflow,
      });

      assert.strictEqual(fixes.length, 1);
      assert.strictEqual(fixes[0]!.fixed, true);
      assert.strictEqual(fixes[0]!.labelReverted, "Doing → To Do");

      // Restore
      h.provider.getPrStatus = originalGetPrStatus;
    });
  });
});
