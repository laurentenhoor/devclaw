/**
 * E2E pipeline tests — exercises the full workflow lifecycle.
 *
 * Tests dispatch → completion → review pass using:
 * - TestProvider (in-memory issues, call tracking)
 * - Mock runCommand (captures gateway calls, task messages)
 * - Real projects.json on disk (temp workspace)
 *
 * Run: npx tsx --test lib/services/pipeline.e2e.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { createTestHarness, type TestHarness } from "../testing/index.js";
import { dispatchTask } from "../dispatch.js";
import { executeCompletion } from "./pipeline.js";
import { reviewPass } from "./review.js";
import { DEFAULT_WORKFLOW } from "../workflow.js";
import { readProjects, getWorker } from "../projects.js";

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("E2E pipeline", () => {
  let h: TestHarness;

  afterEach(async () => {
    if (h) await h.cleanup();
  });

  // =========================================================================
  // Dispatch
  // =========================================================================

  describe("dispatchTask", () => {
    beforeEach(async () => {
      h = await createTestHarness();
      // Seed a "To Do" issue
      h.provider.seedIssue({ iid: 42, title: "Add login page", labels: ["To Do"] });
    });

    it("should transition label, update worker state, and fire gateway calls", async () => {
      const result = await dispatchTask({
        workspaceDir: h.workspaceDir,
        agentId: "test-agent",
        groupId: h.groupId,
        project: h.project,
        issueId: 42,
        issueTitle: "Add login page",
        issueDescription: "Build the login page",
        issueUrl: "https://example.com/issues/42",
        role: "developer",
        level: "medior",
        fromLabel: "To Do",
        toLabel: "Doing",
        transitionLabel: (id, from, to) => h.provider.transitionLabel(id, from, to),
        provider: h.provider,
      });

      // Verify dispatch result
      assert.strictEqual(result.sessionAction, "spawn");
      assert.ok(result.sessionKey.includes("test-project-developer-medior"));
      assert.ok(result.announcement.includes("#42"));
      assert.ok(result.announcement.includes("Add login page"));

      // Verify label transitioned on the issue
      const issue = await h.provider.getIssue(42);
      assert.ok(issue.labels.includes("Doing"), `Expected "Doing" label, got: ${issue.labels}`);
      assert.ok(!issue.labels.includes("To Do"), "Should not have 'To Do' label");

      // Verify worker state updated in projects.json
      const data = await readProjects(h.workspaceDir);
      const worker = getWorker(data.projects[h.groupId], "developer");
      assert.strictEqual(worker.active, true);
      assert.strictEqual(worker.issueId, "42");
      assert.strictEqual(worker.level, "medior");

      // Verify gateway commands were fired
      assert.ok(h.commands.sessionPatches().length > 0, "Should have patched session");
      assert.ok(h.commands.taskMessages().length > 0, "Should have sent task message");

      // Verify task message contains issue context
      const taskMsg = h.commands.taskMessages()[0];
      assert.ok(taskMsg.includes("Add login page"), "Task message should include title");
      assert.ok(taskMsg.includes(h.groupId), "Task message should include groupId");
      assert.ok(taskMsg.includes("work_finish"), "Task message should reference work_finish");
    });

    it("should include comments in task message", async () => {
      h.provider.comments.set(42, [
        { author: "alice", body: "Please use OAuth", created_at: "2026-01-01T00:00:00Z" },
        { author: "bob", body: "Agreed, OAuth2 flow", created_at: "2026-01-02T00:00:00Z" },
      ]);

      await dispatchTask({
        workspaceDir: h.workspaceDir,
        groupId: h.groupId,
        project: h.project,
        issueId: 42,
        issueTitle: "Add login page",
        issueDescription: "",
        issueUrl: "https://example.com/issues/42",
        role: "developer",
        level: "medior",
        fromLabel: "To Do",
        toLabel: "Doing",
        transitionLabel: (id, from, to) => h.provider.transitionLabel(id, from, to),
        provider: h.provider,
      });

      const taskMsg = h.commands.taskMessages()[0];
      assert.ok(taskMsg.includes("alice"), "Should include comment author");
      assert.ok(taskMsg.includes("Please use OAuth"), "Should include comment body");
      assert.ok(taskMsg.includes("bob"), "Should include second comment author");
    });

    it("should reuse existing session when available", async () => {
      // Set up worker with existing session
      h = await createTestHarness({
        workers: {
          developer: {
            sessions: { medior: "agent:test-agent:subagent:test-project-developer-medior" },
          },
        },
      });
      h.provider.seedIssue({ iid: 42, title: "Quick fix", labels: ["To Do"] });

      const result = await dispatchTask({
        workspaceDir: h.workspaceDir,
        agentId: "test-agent",
        groupId: h.groupId,
        project: h.project,
        issueId: 42,
        issueTitle: "Quick fix",
        issueDescription: "",
        issueUrl: "https://example.com/issues/42",
        role: "developer",
        level: "medior",
        fromLabel: "To Do",
        toLabel: "Doing",
        transitionLabel: (id, from, to) => h.provider.transitionLabel(id, from, to),
        provider: h.provider,
      });

      assert.strictEqual(result.sessionAction, "send");
    });
  });

  // =========================================================================
  // Completion — developer:done
  // =========================================================================

  describe("executeCompletion — developer:done", () => {
    beforeEach(async () => {
      h = await createTestHarness({
        workers: {
          developer: { active: true, issueId: "10", level: "medior" },
        },
      });
      h.provider.seedIssue({ iid: 10, title: "Build feature X", labels: ["Doing"] });
    });

    it("should transition Doing → To Test, deactivate worker, run gitPull+detectPr actions", async () => {
      h.provider.mergedMrUrls.set(10, "https://example.com/mr/5");

      const output = await executeCompletion({
        workspaceDir: h.workspaceDir,
        groupId: h.groupId,
        role: "developer",
        result: "done",
        issueId: 10,
        summary: "Built feature X",
        provider: h.provider,
        repoPath: "/tmp/test-repo",
        projectName: "test-project",
      });

      // Label transition
      assert.strictEqual(output.labelTransition, "Doing → To Test");
      assert.ok(output.announcement.includes("#10"));

      // Issue state
      const issue = await h.provider.getIssue(10);
      assert.ok(issue.labels.includes("To Test"), `Labels: ${issue.labels}`);
      assert.ok(!issue.labels.includes("Doing"));

      // Worker deactivated
      const data = await readProjects(h.workspaceDir);
      const worker = getWorker(data.projects[h.groupId], "developer");
      assert.strictEqual(worker.active, false);

      // PR URL detected
      assert.strictEqual(output.prUrl, "https://example.com/mr/5");

      // gitPull action was executed
      const gitCmds = h.commands.commands.filter((c) => c.argv[0] === "git");
      assert.ok(gitCmds.length > 0, "Should have run git pull");
      assert.deepStrictEqual(gitCmds[0].argv, ["git", "pull"]);

      // Issue NOT closed (done goes to To Test, not Done)
      assert.strictEqual(output.issueClosed, false);
    });
  });

  // =========================================================================
  // Completion — developer:review
  // =========================================================================

  describe("executeCompletion — developer:review", () => {
    beforeEach(async () => {
      h = await createTestHarness({
        workers: {
          developer: { active: true, issueId: "20", level: "senior" },
        },
      });
      h.provider.seedIssue({ iid: 20, title: "Refactor auth", labels: ["Doing"] });
    });

    it("should transition Doing → In Review, deactivate worker", async () => {
      const output = await executeCompletion({
        workspaceDir: h.workspaceDir,
        groupId: h.groupId,
        role: "developer",
        result: "review",
        issueId: 20,
        summary: "PR open for review",
        prUrl: "https://example.com/pr/3",
        provider: h.provider,
        repoPath: "/tmp/test-repo",
        projectName: "test-project",
      });

      assert.strictEqual(output.labelTransition, "Doing → In Review");
      assert.ok(output.nextState.includes("review"), `nextState: ${output.nextState}`);

      const issue = await h.provider.getIssue(20);
      assert.ok(issue.labels.includes("In Review"), `Labels: ${issue.labels}`);

      // Worker should be deactivated
      const data = await readProjects(h.workspaceDir);
      assert.strictEqual(getWorker(data.projects[h.groupId], "developer").active, false);

      // Issue should NOT be closed
      assert.strictEqual(output.issueClosed, false);
    });
  });

  // =========================================================================
  // Completion — tester:pass
  // =========================================================================

  describe("executeCompletion — tester:pass", () => {
    beforeEach(async () => {
      h = await createTestHarness({
        workers: {
          tester: { active: true, issueId: "30", level: "medior" },
        },
      });
      h.provider.seedIssue({ iid: 30, title: "Verify login", labels: ["Testing"] });
    });

    it("should transition Testing → Done, close issue", async () => {
      const output = await executeCompletion({
        workspaceDir: h.workspaceDir,
        groupId: h.groupId,
        role: "tester",
        result: "pass",
        issueId: 30,
        summary: "All tests pass",
        provider: h.provider,
        repoPath: "/tmp/test-repo",
        projectName: "test-project",
      });

      assert.strictEqual(output.labelTransition, "Testing → Done");
      assert.strictEqual(output.issueClosed, true);

      const issue = await h.provider.getIssue(30);
      assert.ok(issue.labels.includes("Done"));
      assert.strictEqual(issue.state, "closed");

      // Verify closeIssue was called
      const closeCalls = h.provider.callsTo("closeIssue");
      assert.strictEqual(closeCalls.length, 1);
      assert.strictEqual(closeCalls[0].args.issueId, 30);
    });
  });

  // =========================================================================
  // Completion — tester:fail
  // =========================================================================

  describe("executeCompletion — tester:fail", () => {
    beforeEach(async () => {
      h = await createTestHarness({
        workers: {
          tester: { active: true, issueId: "40", level: "medior" },
        },
      });
      h.provider.seedIssue({ iid: 40, title: "Check signup", labels: ["Testing"] });
    });

    it("should transition Testing → To Improve, reopen issue", async () => {
      const output = await executeCompletion({
        workspaceDir: h.workspaceDir,
        groupId: h.groupId,
        role: "tester",
        result: "fail",
        issueId: 40,
        summary: "Signup form validation broken",
        provider: h.provider,
        repoPath: "/tmp/test-repo",
        projectName: "test-project",
      });

      assert.strictEqual(output.labelTransition, "Testing → To Improve");
      assert.strictEqual(output.issueReopened, true);

      const issue = await h.provider.getIssue(40);
      assert.ok(issue.labels.includes("To Improve"));
      assert.strictEqual(issue.state, "opened");

      const reopenCalls = h.provider.callsTo("reopenIssue");
      assert.strictEqual(reopenCalls.length, 1);
    });
  });

  // =========================================================================
  // Completion — developer:blocked
  // =========================================================================

  describe("executeCompletion — developer:blocked", () => {
    beforeEach(async () => {
      h = await createTestHarness({
        workers: {
          developer: { active: true, issueId: "50", level: "junior" },
        },
      });
      h.provider.seedIssue({ iid: 50, title: "Fix CSS", labels: ["Doing"] });
    });

    it("should transition Doing → Refining, no close/reopen", async () => {
      const output = await executeCompletion({
        workspaceDir: h.workspaceDir,
        groupId: h.groupId,
        role: "developer",
        result: "blocked",
        issueId: 50,
        summary: "Need design decision",
        provider: h.provider,
        repoPath: "/tmp/test-repo",
        projectName: "test-project",
      });

      assert.strictEqual(output.labelTransition, "Doing → Refining");
      assert.strictEqual(output.issueClosed, false);
      assert.strictEqual(output.issueReopened, false);

      const issue = await h.provider.getIssue(50);
      assert.ok(issue.labels.includes("Refining"));
    });
  });

  // =========================================================================
  // Review pass
  // =========================================================================

  describe("reviewPass", () => {
    beforeEach(async () => {
      h = await createTestHarness();
    });

    it("should transition In Review → To Test when PR is merged", async () => {
      // Seed issue in "In Review" state
      h.provider.seedIssue({ iid: 60, title: "Feature Y", labels: ["In Review"] });
      h.provider.setPrStatus(60, { state: "merged", url: "https://example.com/pr/10" });

      const transitions = await reviewPass({
        workspaceDir: h.workspaceDir,
        groupId: h.groupId,
        workflow: DEFAULT_WORKFLOW,
        provider: h.provider,
        repoPath: "/tmp/test-repo",
      });

      assert.strictEqual(transitions, 1);

      // Issue should now have "To Test" label
      const issue = await h.provider.getIssue(60);
      assert.ok(issue.labels.includes("To Test"), `Labels: ${issue.labels}`);
      assert.ok(!issue.labels.includes("In Review"), "Should not have In Review");

      // gitPull action should have been attempted
      const gitCmds = h.commands.commands.filter((c) => c.argv[0] === "git");
      assert.ok(gitCmds.length > 0, "Should have run git pull");
    });

    it("should NOT transition when PR is still open", async () => {
      h.provider.seedIssue({ iid: 61, title: "Feature Z", labels: ["In Review"] });
      h.provider.setPrStatus(61, { state: "open", url: "https://example.com/pr/11" });

      const transitions = await reviewPass({
        workspaceDir: h.workspaceDir,
        groupId: h.groupId,
        workflow: DEFAULT_WORKFLOW,
        provider: h.provider,
        repoPath: "/tmp/test-repo",
      });

      assert.strictEqual(transitions, 0);

      // Issue should still have "In Review"
      const issue = await h.provider.getIssue(61);
      assert.ok(issue.labels.includes("In Review"));
    });

    it("should handle multiple review issues in one pass", async () => {
      h.provider.seedIssue({ iid: 70, title: "PR A", labels: ["In Review"] });
      h.provider.seedIssue({ iid: 71, title: "PR B", labels: ["In Review"] });
      h.provider.setPrStatus(70, { state: "merged", url: "https://example.com/pr/20" });
      h.provider.setPrStatus(71, { state: "merged", url: "https://example.com/pr/21" });

      const transitions = await reviewPass({
        workspaceDir: h.workspaceDir,
        groupId: h.groupId,
        workflow: DEFAULT_WORKFLOW,
        provider: h.provider,
        repoPath: "/tmp/test-repo",
      });

      assert.strictEqual(transitions, 2);

      const issue70 = await h.provider.getIssue(70);
      const issue71 = await h.provider.getIssue(71);
      assert.ok(issue70.labels.includes("To Test"));
      assert.ok(issue71.labels.includes("To Test"));
    });
  });

  // =========================================================================
  // Full lifecycle: dispatch → complete → review → test → done
  // =========================================================================

  describe("full lifecycle", () => {
    it("developer:done → tester:pass (direct path)", async () => {
      h = await createTestHarness();

      // 1. Seed issue in To Do
      h.provider.seedIssue({ iid: 100, title: "Build dashboard", labels: ["To Do"] });

      // 2. Dispatch developer
      await dispatchTask({
        workspaceDir: h.workspaceDir,
        agentId: "main",
        groupId: h.groupId,
        project: h.project,
        issueId: 100,
        issueTitle: "Build dashboard",
        issueDescription: "Create the main dashboard view",
        issueUrl: "https://example.com/issues/100",
        role: "developer",
        level: "medior",
        fromLabel: "To Do",
        toLabel: "Doing",
        transitionLabel: (id, from, to) => h.provider.transitionLabel(id, from, to),
        provider: h.provider,
      });

      let issue = await h.provider.getIssue(100);
      assert.ok(issue.labels.includes("Doing"));

      // 3. Developer completes → To Test
      await executeCompletion({
        workspaceDir: h.workspaceDir,
        groupId: h.groupId,
        role: "developer",
        result: "done",
        issueId: 100,
        summary: "Dashboard built",
        provider: h.provider,
        repoPath: "/tmp/test-repo",
        projectName: "test-project",
      });

      issue = await h.provider.getIssue(100);
      assert.ok(issue.labels.includes("To Test"), `After dev done: ${issue.labels}`);

      // 4. Simulate tester dispatch (activate worker manually for completion)
      const { activateWorker } = await import("../projects.js");
      await activateWorker(h.workspaceDir, h.groupId, "tester", {
        issueId: "100", level: "medior",
      });
      await h.provider.transitionLabel(100, "To Test", "Testing");

      // 5. Tester passes → Done
      await executeCompletion({
        workspaceDir: h.workspaceDir,
        groupId: h.groupId,
        role: "tester",
        result: "pass",
        issueId: 100,
        summary: "All checks passed",
        provider: h.provider,
        repoPath: "/tmp/test-repo",
        projectName: "test-project",
      });

      issue = await h.provider.getIssue(100);
      assert.ok(issue.labels.includes("Done"), `Final state: ${issue.labels}`);
      assert.strictEqual(issue.state, "closed");
    });

    it("developer:review → review pass → tester:pass (review path)", async () => {
      h = await createTestHarness();

      // 1. Seed issue in To Do
      h.provider.seedIssue({ iid: 200, title: "Auth refactor", labels: ["To Do"] });

      // 2. Dispatch developer
      await dispatchTask({
        workspaceDir: h.workspaceDir,
        agentId: "main",
        groupId: h.groupId,
        project: h.project,
        issueId: 200,
        issueTitle: "Auth refactor",
        issueDescription: "Refactor authentication system",
        issueUrl: "https://example.com/issues/200",
        role: "developer",
        level: "senior",
        fromLabel: "To Do",
        toLabel: "Doing",
        transitionLabel: (id, from, to) => h.provider.transitionLabel(id, from, to),
        provider: h.provider,
      });

      // 3. Developer finishes with "review" → In Review
      await executeCompletion({
        workspaceDir: h.workspaceDir,
        groupId: h.groupId,
        role: "developer",
        result: "review",
        issueId: 200,
        summary: "PR ready for review",
        prUrl: "https://example.com/pr/50",
        provider: h.provider,
        repoPath: "/tmp/test-repo",
        projectName: "test-project",
      });

      let issue = await h.provider.getIssue(200);
      assert.ok(issue.labels.includes("In Review"), `After review: ${issue.labels}`);

      // 4. PR gets merged — review pass picks it up
      h.provider.setPrStatus(200, { state: "merged", url: "https://example.com/pr/50" });

      const transitions = await reviewPass({
        workspaceDir: h.workspaceDir,
        groupId: h.groupId,
        workflow: DEFAULT_WORKFLOW,
        provider: h.provider,
        repoPath: "/tmp/test-repo",
      });

      assert.strictEqual(transitions, 1);
      issue = await h.provider.getIssue(200);
      assert.ok(issue.labels.includes("To Test"), `After review pass: ${issue.labels}`);

      // 5. Tester passes → Done
      const { activateWorker } = await import("../projects.js");
      await activateWorker(h.workspaceDir, h.groupId, "tester", {
        issueId: "200", level: "medior",
      });
      await h.provider.transitionLabel(200, "To Test", "Testing");

      await executeCompletion({
        workspaceDir: h.workspaceDir,
        groupId: h.groupId,
        role: "tester",
        result: "pass",
        issueId: 200,
        summary: "Auth refactor verified",
        provider: h.provider,
        repoPath: "/tmp/test-repo",
        projectName: "test-project",
      });

      issue = await h.provider.getIssue(200);
      assert.ok(issue.labels.includes("Done"), `Final state: ${issue.labels}`);
      assert.strictEqual(issue.state, "closed");
    });

    it("developer:done → tester:fail → developer:done → tester:pass (fail cycle)", async () => {
      h = await createTestHarness();

      h.provider.seedIssue({ iid: 300, title: "Payment flow", labels: ["To Do"] });

      // 1. Dispatch developer
      await dispatchTask({
        workspaceDir: h.workspaceDir,
        agentId: "main",
        groupId: h.groupId,
        project: h.project,
        issueId: 300,
        issueTitle: "Payment flow",
        issueDescription: "Implement payment",
        issueUrl: "https://example.com/issues/300",
        role: "developer",
        level: "medior",
        fromLabel: "To Do",
        toLabel: "Doing",
        transitionLabel: (id, from, to) => h.provider.transitionLabel(id, from, to),
        provider: h.provider,
      });

      // 2. Developer done → To Test
      await executeCompletion({
        workspaceDir: h.workspaceDir,
        groupId: h.groupId,
        role: "developer",
        result: "done",
        issueId: 300,
        provider: h.provider,
        repoPath: "/tmp/test-repo",
        projectName: "test-project",
      });

      // 3. Activate tester + transition
      const { activateWorker } = await import("../projects.js");
      await activateWorker(h.workspaceDir, h.groupId, "tester", {
        issueId: "300", level: "medior",
      });
      await h.provider.transitionLabel(300, "To Test", "Testing");

      // 4. Tester FAILS → To Improve
      await executeCompletion({
        workspaceDir: h.workspaceDir,
        groupId: h.groupId,
        role: "tester",
        result: "fail",
        issueId: 300,
        summary: "Validation broken",
        provider: h.provider,
        repoPath: "/tmp/test-repo",
        projectName: "test-project",
      });

      let issue = await h.provider.getIssue(300);
      assert.ok(issue.labels.includes("To Improve"), `After fail: ${issue.labels}`);
      assert.strictEqual(issue.state, "opened"); // reopened

      // 5. Developer picks up again (To Improve → Doing)
      await dispatchTask({
        workspaceDir: h.workspaceDir,
        agentId: "main",
        groupId: h.groupId,
        project: (await readProjects(h.workspaceDir)).projects[h.groupId],
        issueId: 300,
        issueTitle: "Payment flow",
        issueDescription: "Implement payment",
        issueUrl: "https://example.com/issues/300",
        role: "developer",
        level: "medior",
        fromLabel: "To Improve",
        toLabel: "Doing",
        transitionLabel: (id, from, to) => h.provider.transitionLabel(id, from, to),
        provider: h.provider,
      });

      // 6. Developer fixes it → To Test
      await executeCompletion({
        workspaceDir: h.workspaceDir,
        groupId: h.groupId,
        role: "developer",
        result: "done",
        issueId: 300,
        summary: "Fixed validation",
        provider: h.provider,
        repoPath: "/tmp/test-repo",
        projectName: "test-project",
      });

      issue = await h.provider.getIssue(300);
      assert.ok(issue.labels.includes("To Test"), `After fix: ${issue.labels}`);

      // 7. Tester passes → Done
      await activateWorker(h.workspaceDir, h.groupId, "tester", {
        issueId: "300", level: "medior",
      });
      await h.provider.transitionLabel(300, "To Test", "Testing");

      await executeCompletion({
        workspaceDir: h.workspaceDir,
        groupId: h.groupId,
        role: "tester",
        result: "pass",
        issueId: 300,
        summary: "All good now",
        provider: h.provider,
        repoPath: "/tmp/test-repo",
        projectName: "test-project",
      });

      issue = await h.provider.getIssue(300);
      assert.ok(issue.labels.includes("Done"), `Final state: ${issue.labels}`);
      assert.strictEqual(issue.state, "closed");
    });
  });

  // =========================================================================
  // Provider call tracking
  // =========================================================================

  describe("provider call tracking", () => {
    it("should track all provider interactions during completion", async () => {
      h = await createTestHarness({
        workers: {
          tester: { active: true, issueId: "90", level: "medior" },
        },
      });
      h.provider.seedIssue({ iid: 90, title: "Test tracking", labels: ["Testing"] });
      h.provider.resetCalls();

      await executeCompletion({
        workspaceDir: h.workspaceDir,
        groupId: h.groupId,
        role: "tester",
        result: "pass",
        issueId: 90,
        provider: h.provider,
        repoPath: "/tmp/test-repo",
        projectName: "test-project",
      });

      // Should have: getIssue (for URL), transitionLabel, closeIssue
      assert.ok(h.provider.callsTo("getIssue").length >= 1, "Should call getIssue");
      assert.strictEqual(h.provider.callsTo("transitionLabel").length, 1);
      assert.strictEqual(h.provider.callsTo("closeIssue").length, 1);

      // Verify transition args
      const transition = h.provider.callsTo("transitionLabel")[0];
      assert.strictEqual(transition.args.issueId, 90);
      assert.strictEqual(transition.args.from, "Testing");
      assert.strictEqual(transition.args.to, "Done");
    });
  });
});
