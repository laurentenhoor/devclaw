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
import { projectTick } from "./tick.js";
import { reviewPass } from "./review.js";
import { DEFAULT_WORKFLOW, ReviewPolicy, type WorkflowConfig } from "../workflow.js";
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
  // Completion — developer:done → To Review (always)
  // =========================================================================

  describe("executeCompletion — developer:done → To Review", () => {
    beforeEach(async () => {
      h = await createTestHarness({
        workers: {
          developer: { active: true, issueId: "10", level: "medior" },
        },
      });
      h.provider.seedIssue({ iid: 10, title: "Build feature X", labels: ["Doing"] });
    });

    it("should transition Doing → To Review", async () => {
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

      assert.strictEqual(output.labelTransition, "Doing → To Review");
      assert.ok(output.announcement.includes("#10"));

      const issue = await h.provider.getIssue(10);
      assert.ok(issue.labels.includes("To Review"), `Labels: ${issue.labels}`);
      assert.ok(!issue.labels.includes("Doing"));

      const data = await readProjects(h.workspaceDir);
      assert.strictEqual(getWorker(data.projects[h.groupId], "developer").active, false);
      assert.strictEqual(output.issueClosed, false);
    });
  });

  // =========================================================================
  // Completion — reviewer:approve / reject
  // =========================================================================

  describe("executeCompletion — reviewer", () => {
    beforeEach(async () => {
      h = await createTestHarness({
        workers: {
          reviewer: { active: true, issueId: "25", level: "junior" },
        },
      });
      h.provider.seedIssue({ iid: 25, title: "Review PR", labels: ["Reviewing"] });
    });

    it("reviewer:approve should transition Reviewing → To Test, merge PR", async () => {
      h.provider.setPrStatus(25, { state: "open", url: "https://example.com/pr/7" });

      const output = await executeCompletion({
        workspaceDir: h.workspaceDir,
        groupId: h.groupId,
        role: "reviewer",
        result: "approve",
        issueId: 25,
        summary: "Code looks good",
        provider: h.provider,
        repoPath: "/tmp/test-repo",
        projectName: "test-project",
      });

      assert.strictEqual(output.labelTransition, "Reviewing → To Test");
      const issue = await h.provider.getIssue(25);
      assert.ok(issue.labels.includes("To Test"), `Labels: ${issue.labels}`);

      const mergeCalls = h.provider.callsTo("mergePr");
      assert.strictEqual(mergeCalls.length, 1);
    });

    it("reviewer:reject should transition Reviewing → To Improve", async () => {
      const output = await executeCompletion({
        workspaceDir: h.workspaceDir,
        groupId: h.groupId,
        role: "reviewer",
        result: "reject",
        issueId: 25,
        summary: "Missing error handling",
        provider: h.provider,
        repoPath: "/tmp/test-repo",
        projectName: "test-project",
      });

      assert.strictEqual(output.labelTransition, "Reviewing → To Improve");
      const issue = await h.provider.getIssue(25);
      assert.ok(issue.labels.includes("To Improve"), `Labels: ${issue.labels}`);
    });

    it("reviewer:blocked should transition Reviewing → Refining", async () => {
      const output = await executeCompletion({
        workspaceDir: h.workspaceDir,
        groupId: h.groupId,
        role: "reviewer",
        result: "blocked",
        issueId: 25,
        summary: "Can't determine correctness",
        provider: h.provider,
        repoPath: "/tmp/test-repo",
        projectName: "test-project",
      });

      assert.strictEqual(output.labelTransition, "Reviewing → Refining");
      const issue = await h.provider.getIssue(25);
      assert.ok(issue.labels.includes("Refining"), `Labels: ${issue.labels}`);
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
  // Review pass — heartbeat polls To Review for human path
  // =========================================================================

  describe("reviewPass", () => {
    beforeEach(async () => {
      h = await createTestHarness();
    });

    it("should auto-merge and transition To Review → To Test when PR is approved", async () => {
      h.provider.seedIssue({ iid: 60, title: "Feature Y", labels: ["To Review"] });
      h.provider.setPrStatus(60, { state: "approved", url: "https://example.com/pr/10" });

      const transitions = await reviewPass({
        workspaceDir: h.workspaceDir,
        groupId: h.groupId,
        workflow: DEFAULT_WORKFLOW,
        provider: h.provider,
        repoPath: "/tmp/test-repo",
      });

      assert.strictEqual(transitions, 1);

      const issue = await h.provider.getIssue(60);
      assert.ok(issue.labels.includes("To Test"), `Labels: ${issue.labels}`);
      assert.ok(!issue.labels.includes("To Review"), "Should not have To Review");

      const mergeCalls = h.provider.callsTo("mergePr");
      assert.strictEqual(mergeCalls.length, 1);
      assert.strictEqual(mergeCalls[0].args.issueId, 60);

      const gitCmds = h.commands.commands.filter((c) => c.argv[0] === "git");
      assert.ok(gitCmds.length > 0, "Should have run git pull");
    });

    it("should NOT transition when PR is still open", async () => {
      h.provider.seedIssue({ iid: 61, title: "Feature Z", labels: ["To Review"] });
      h.provider.setPrStatus(61, { state: "open", url: "https://example.com/pr/11" });

      const transitions = await reviewPass({
        workspaceDir: h.workspaceDir,
        groupId: h.groupId,
        workflow: DEFAULT_WORKFLOW,
        provider: h.provider,
        repoPath: "/tmp/test-repo",
      });

      assert.strictEqual(transitions, 0);

      const issue = await h.provider.getIssue(61);
      assert.ok(issue.labels.includes("To Review"));
    });

    it("should handle multiple review issues in one pass", async () => {
      h.provider.seedIssue({ iid: 70, title: "PR A", labels: ["To Review"] });
      h.provider.seedIssue({ iid: 71, title: "PR B", labels: ["To Review"] });
      h.provider.setPrStatus(70, { state: "approved", url: "https://example.com/pr/20" });
      h.provider.setPrStatus(71, { state: "approved", url: "https://example.com/pr/21" });

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

      const mergeCalls = h.provider.callsTo("mergePr");
      assert.strictEqual(mergeCalls.length, 2);
    });

    it("should transition To Review → To Improve when merge fails (conflicts)", async () => {
      h.provider.seedIssue({ iid: 65, title: "Conflicting PR", labels: ["To Review"] });
      h.provider.setPrStatus(65, { state: "approved", url: "https://example.com/pr/15" });
      h.provider.mergePrFailures.add(65);

      const transitions = await reviewPass({
        workspaceDir: h.workspaceDir,
        groupId: h.groupId,
        workflow: DEFAULT_WORKFLOW,
        provider: h.provider,
        repoPath: "/tmp/test-repo",
      });

      assert.strictEqual(transitions, 1);

      const issue = await h.provider.getIssue(65);
      assert.ok(issue.labels.includes("To Improve"), `Labels: ${issue.labels}`);
      assert.ok(!issue.labels.includes("To Review"), "Should not have To Review");
      assert.ok(!issue.labels.includes("To Test"), "Should NOT have To Test");

      const mergeCalls = h.provider.callsTo("mergePr");
      assert.strictEqual(mergeCalls.length, 1);

      const gitCmds = h.commands.commands.filter((c) => c.argv[0] === "git");
      assert.strictEqual(gitCmds.length, 0, "Should NOT have run git pull after merge failure");
    });
  });

  // =========================================================================
  // Full lifecycle: dispatch → complete → review → test → done
  // =========================================================================

  describe("full lifecycle", () => {
    it("developer:done → reviewer:approve → tester:pass (agent review path)", async () => {
      h = await createTestHarness();

      // 1. Seed issue
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

      // 3. Developer done → To Review
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

      let issue = await h.provider.getIssue(100);
      assert.ok(issue.labels.includes("To Review"), `After dev done: ${issue.labels}`);

      // 4. Reviewer dispatched → Reviewing → approve → To Test
      const { activateWorker } = await import("../projects.js");
      await activateWorker(h.workspaceDir, h.groupId, "reviewer", {
        issueId: "100", level: "junior",
      });
      await h.provider.transitionLabel(100, "To Review", "Reviewing");

      await executeCompletion({
        workspaceDir: h.workspaceDir,
        groupId: h.groupId,
        role: "reviewer",
        result: "approve",
        issueId: 100,
        summary: "Code looks good",
        provider: h.provider,
        repoPath: "/tmp/test-repo",
        projectName: "test-project",
      });

      issue = await h.provider.getIssue(100);
      assert.ok(issue.labels.includes("To Test"), `After reviewer approve: ${issue.labels}`);

      // 5. Tester passes → Done
      await activateWorker(h.workspaceDir, h.groupId, "tester", {
        issueId: "100", level: "medior",
      });
      await h.provider.transitionLabel(100, "To Test", "Testing");

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

    it("developer:done → human review pass → tester:pass (human review path)", async () => {
      h = await createTestHarness();

      h.provider.seedIssue({ iid: 200, title: "Auth refactor", labels: ["To Do"] });

      // 1. Dispatch developer
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

      // 2. Developer done → To Review (same state regardless of level)
      await executeCompletion({
        workspaceDir: h.workspaceDir,
        groupId: h.groupId,
        role: "developer",
        result: "done",
        issueId: 200,
        summary: "PR ready for review",
        prUrl: "https://example.com/pr/50",
        provider: h.provider,
        repoPath: "/tmp/test-repo",
        projectName: "test-project",
      });

      let issue = await h.provider.getIssue(200);
      assert.ok(issue.labels.includes("To Review"), `After dev done: ${issue.labels}`);

      // 3. Human reviews PR → approved → heartbeat transitions To Review → To Test
      h.provider.setPrStatus(200, { state: "approved", url: "https://example.com/pr/50" });

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

      // 4. Tester passes → Done
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

    it("developer:done → reviewer:reject → developer:done → reviewer:approve → tester:pass (reject cycle)", async () => {
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

      // 2. Developer done → To Review
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

      let issue = await h.provider.getIssue(300);
      assert.ok(issue.labels.includes("To Review"), `After dev done: ${issue.labels}`);

      // 3. Reviewer REJECTS → To Improve
      const { activateWorker } = await import("../projects.js");
      await activateWorker(h.workspaceDir, h.groupId, "reviewer", {
        issueId: "300", level: "junior",
      });
      await h.provider.transitionLabel(300, "To Review", "Reviewing");

      await executeCompletion({
        workspaceDir: h.workspaceDir,
        groupId: h.groupId,
        role: "reviewer",
        result: "reject",
        issueId: 300,
        summary: "Missing validation",
        provider: h.provider,
        repoPath: "/tmp/test-repo",
        projectName: "test-project",
      });

      issue = await h.provider.getIssue(300);
      assert.ok(issue.labels.includes("To Improve"), `After reject: ${issue.labels}`);

      // 4. Developer picks up again → fixes → To Review
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
      assert.ok(issue.labels.includes("To Review"), `After fix: ${issue.labels}`);

      // 5. Reviewer approves this time → To Test
      await activateWorker(h.workspaceDir, h.groupId, "reviewer", {
        issueId: "300", level: "junior",
      });
      await h.provider.transitionLabel(300, "To Review", "Reviewing");

      await executeCompletion({
        workspaceDir: h.workspaceDir,
        groupId: h.groupId,
        role: "reviewer",
        result: "approve",
        issueId: 300,
        summary: "Looks good now",
        provider: h.provider,
        repoPath: "/tmp/test-repo",
        projectName: "test-project",
      });

      issue = await h.provider.getIssue(300);
      assert.ok(issue.labels.includes("To Test"), `After approve: ${issue.labels}`);

      // 6. Tester passes → Done
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
  // Review policy gating — projectTick respects reviewPolicy
  // =========================================================================

  describe("projectTick — reviewPolicy gating", () => {
    function workflowWithPolicy(policy: ReviewPolicy): WorkflowConfig {
      return { ...DEFAULT_WORKFLOW, reviewPolicy: policy };
    }

    it("reviewPolicy: human should skip reviewer dispatch", async () => {
      h = await createTestHarness();
      h.provider.seedIssue({ iid: 80, title: "Needs review", labels: ["To Review"] });

      const result = await projectTick({
        workspaceDir: h.workspaceDir,
        groupId: h.groupId,
        targetRole: "reviewer",
        workflow: workflowWithPolicy(ReviewPolicy.HUMAN),
        provider: h.provider,
      });

      assert.strictEqual(result.pickups.length, 0, "Should NOT dispatch reviewer");
      const reviewerSkip = result.skipped.find((s) => s.role === "reviewer");
      assert.ok(reviewerSkip, "Should have skipped reviewer");
      assert.ok(reviewerSkip!.reason.includes("human"), `Skip reason: ${reviewerSkip!.reason}`);
    });

    it("reviewPolicy: agent should dispatch reviewer", async () => {
      h = await createTestHarness();
      h.provider.seedIssue({ iid: 81, title: "Needs review", labels: ["To Review"] });

      const result = await projectTick({
        workspaceDir: h.workspaceDir,
        groupId: h.groupId,
        agentId: "test-agent",
        targetRole: "reviewer",
        workflow: workflowWithPolicy(ReviewPolicy.AGENT),
        provider: h.provider,
      });

      assert.strictEqual(result.pickups.length, 1, "Should dispatch reviewer");
      assert.strictEqual(result.pickups[0].role, "reviewer");
    });

    it("reviewPolicy: auto should dispatch reviewer for junior-level issues", async () => {
      h = await createTestHarness();
      h.provider.seedIssue({ iid: 82, title: "Small fix", labels: ["To Review"] });

      const result = await projectTick({
        workspaceDir: h.workspaceDir,
        groupId: h.groupId,
        agentId: "test-agent",
        targetRole: "reviewer",
        workflow: workflowWithPolicy(ReviewPolicy.AUTO),
        provider: h.provider,
      });

      // Junior/medior should be dispatched under auto policy
      assert.strictEqual(result.pickups.length, 1, "Should dispatch reviewer for non-senior");
    });

    it("reviewPolicy: auto should skip reviewer for senior-level issues (review:human label)", async () => {
      h = await createTestHarness();
      // dispatch applies review:human for senior developers (via resolveReviewRouting)
      h.provider.seedIssue({ iid: 83, title: "Architecture rework", labels: ["To Review", "developer:senior", "review:human"] });

      const result = await projectTick({
        workspaceDir: h.workspaceDir,
        groupId: h.groupId,
        targetRole: "reviewer",
        workflow: workflowWithPolicy(ReviewPolicy.AUTO),
        provider: h.provider,
      });

      assert.strictEqual(result.pickups.length, 0, "Should NOT dispatch reviewer for review:human");
      const reviewerSkip = result.skipped.find((s) => s.role === "reviewer");
      assert.ok(reviewerSkip, "Should have skipped reviewer");
      assert.ok(reviewerSkip!.reason.includes("review:human"), `Skip reason: ${reviewerSkip!.reason}`);
    });

    it("reviewPolicy: human should still allow developer and tester dispatch", async () => {
      h = await createTestHarness();
      h.provider.seedIssue({ iid: 84, title: "Dev task", labels: ["To Do"] });
      h.provider.seedIssue({ iid: 85, title: "Test task", labels: ["To Test"] });

      const result = await projectTick({
        workspaceDir: h.workspaceDir,
        groupId: h.groupId,
        agentId: "test-agent",
        workflow: workflowWithPolicy(ReviewPolicy.HUMAN),
        provider: h.provider,
      });

      const roles = result.pickups.map((p) => p.role);
      assert.ok(roles.includes("developer"), `Should dispatch developer, got: ${roles}`);
      assert.ok(roles.includes("tester"), `Should dispatch tester, got: ${roles}`);
      assert.ok(!roles.includes("reviewer"), "Should NOT dispatch reviewer");
    });
  });

  // =========================================================================
  // Role:level labels — dispatch applies labels, tick reads them
  // =========================================================================

  describe("role:level labels", () => {
    it("dispatch should apply role:level label to issue", async () => {
      h = await createTestHarness();
      h.provider.seedIssue({ iid: 400, title: "Label test", labels: ["To Do"] });

      await dispatchTask({
        workspaceDir: h.workspaceDir,
        agentId: "test-agent",
        groupId: h.groupId,
        project: h.project,
        issueId: 400,
        issueTitle: "Label test",
        issueDescription: "",
        issueUrl: "https://example.com/issues/400",
        role: "developer",
        level: "senior",
        fromLabel: "To Do",
        toLabel: "Doing",
        transitionLabel: (id, from, to) => h.provider.transitionLabel(id, from, to),
        provider: h.provider,
      });

      const issue = await h.provider.getIssue(400);
      assert.ok(issue.labels.includes("developer:senior"), `Should have developer:senior, got: ${issue.labels}`);
      assert.ok(issue.labels.includes("Doing"), "Should have Doing label");
      // Senior developer dispatch should also apply review:human routing label
      assert.ok(issue.labels.includes("review:human"), `Should have review:human for senior, got: ${issue.labels}`);
    });

    it("dispatch should apply review:agent label for non-senior developer", async () => {
      h = await createTestHarness();
      h.provider.seedIssue({ iid: 404, title: "Junior task", labels: ["To Do"] });

      await dispatchTask({
        workspaceDir: h.workspaceDir,
        agentId: "test-agent",
        groupId: h.groupId,
        project: h.project,
        issueId: 404,
        issueTitle: "Junior task",
        issueDescription: "",
        issueUrl: "https://example.com/issues/404",
        role: "developer",
        level: "junior",
        fromLabel: "To Do",
        toLabel: "Doing",
        transitionLabel: (id, from, to) => h.provider.transitionLabel(id, from, to),
        provider: h.provider,
      });

      const issue = await h.provider.getIssue(404);
      assert.ok(issue.labels.includes("developer:junior"), `Should have developer:junior, got: ${issue.labels}`);
      assert.ok(issue.labels.includes("review:agent"), `Should have review:agent for junior, got: ${issue.labels}`);
    });

    it("dispatch should replace old role:level label", async () => {
      h = await createTestHarness();
      // Issue already has a developer:junior label from a previous dispatch
      h.provider.seedIssue({ iid: 401, title: "Re-dispatch", labels: ["To Improve", "developer:junior"] });

      await dispatchTask({
        workspaceDir: h.workspaceDir,
        agentId: "test-agent",
        groupId: h.groupId,
        project: h.project,
        issueId: 401,
        issueTitle: "Re-dispatch",
        issueDescription: "",
        issueUrl: "https://example.com/issues/401",
        role: "developer",
        level: "medior",
        fromLabel: "To Improve",
        toLabel: "Doing",
        transitionLabel: (id, from, to) => h.provider.transitionLabel(id, from, to),
        provider: h.provider,
      });

      const issue = await h.provider.getIssue(401);
      assert.ok(issue.labels.includes("developer:medior"), `Should have developer:medior, got: ${issue.labels}`);
      assert.ok(!issue.labels.includes("developer:junior"), "Should NOT have developer:junior");
    });

    it("projectTick should skip reviewer when review:human label present", async () => {
      h = await createTestHarness();
      // review:human applied by dispatch for senior developers
      h.provider.seedIssue({ iid: 402, title: "Senior review", labels: ["To Review", "developer:senior", "review:human"] });

      const result = await projectTick({
        workspaceDir: h.workspaceDir,
        groupId: h.groupId,
        targetRole: "reviewer",
        workflow: { ...DEFAULT_WORKFLOW, reviewPolicy: ReviewPolicy.AUTO },
        provider: h.provider,
      });

      assert.strictEqual(result.pickups.length, 0, "Should NOT dispatch reviewer for review:human");
      const reviewerSkip = result.skipped.find((s) => s.role === "reviewer");
      assert.ok(reviewerSkip, "Should have skipped reviewer");
      assert.ok(reviewerSkip!.reason.includes("review:human"), `Skip reason: ${reviewerSkip!.reason}`);
    });

    it("projectTick should dispatch reviewer when review:agent label present", async () => {
      h = await createTestHarness();
      h.provider.seedIssue({ iid: 403, title: "Junior fix", labels: ["To Review", "developer:junior", "review:agent"] });

      const result = await projectTick({
        workspaceDir: h.workspaceDir,
        groupId: h.groupId,
        agentId: "test-agent",
        targetRole: "reviewer",
        workflow: { ...DEFAULT_WORKFLOW, reviewPolicy: ReviewPolicy.AUTO },
        provider: h.provider,
      });

      assert.strictEqual(result.pickups.length, 1, "Should dispatch reviewer for review:agent");
      assert.strictEqual(result.pickups[0].role, "reviewer");
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
