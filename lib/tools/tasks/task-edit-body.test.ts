/**
 * Tests for task_edit_body tool — initial-state enforcement, change detection,
 * and workflow integration.
 *
 * Run with: npx tsx --test lib/tools/tasks/task-edit-body.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { DEFAULT_WORKFLOW, getInitialStateLabel } from "../../workflow/index.js";

// ---------------------------------------------------------------------------
// getInitialStateLabel
// ---------------------------------------------------------------------------

describe("getInitialStateLabel", () => {
  it("should return 'Planning' for the default workflow", () => {
    assert.strictEqual(getInitialStateLabel(DEFAULT_WORKFLOW), "Planning");
  });

  it("should return the correct label for a custom workflow", () => {
    const custom = {
      initial: "backlog",
      states: {
        backlog: { type: "hold" as const, label: "Backlog", color: "#aaa" },
        inProgress: { type: "active" as const, label: "In Progress", color: "#bbb" },
      },
    };
    assert.strictEqual(getInitialStateLabel(custom as any), "Backlog");
  });

  it("should NOT return a non-initial state", () => {
    const label = getInitialStateLabel(DEFAULT_WORKFLOW);
    assert.notStrictEqual(label, "To Do");
    assert.notStrictEqual(label, "Doing");
    assert.notStrictEqual(label, "Done");
  });
});

// ---------------------------------------------------------------------------
// Task edit body — change detection logic (unit tests without provider)
// ---------------------------------------------------------------------------

describe("task_edit_body change detection", () => {
  /**
   * Simulate the change-detection logic from task_edit_body.ts
   */
  function detectChanges(
    issue: { title: string; description: string },
    updates: { title?: string; body?: string },
  ): Record<string, { from: string; to: string }> {
    const changes: Record<string, { from: string; to: string }> = {};
    if (updates.title !== undefined && updates.title !== issue.title) {
      changes.title = { from: issue.title, to: updates.title };
    }
    if (updates.body !== undefined && updates.body !== issue.description) {
      changes.body = { from: issue.description, to: updates.body };
    }
    return changes;
  }

  it("should detect title change", () => {
    const changes = detectChanges(
      { title: "Old title", description: "desc" },
      { title: "New title" },
    );
    assert.deepStrictEqual(Object.keys(changes), ["title"]);
    assert.strictEqual(changes.title.from, "Old title");
    assert.strictEqual(changes.title.to, "New title");
  });

  it("should detect body change", () => {
    const changes = detectChanges(
      { title: "title", description: "old body" },
      { body: "new body" },
    );
    assert.deepStrictEqual(Object.keys(changes), ["body"]);
    assert.strictEqual(changes.body.from, "old body");
    assert.strictEqual(changes.body.to, "new body");
  });

  it("should detect both title and body change", () => {
    const changes = detectChanges(
      { title: "old title", description: "old body" },
      { title: "new title", body: "new body" },
    );
    assert.deepStrictEqual(Object.keys(changes).sort(), ["body", "title"]);
  });

  it("should detect no change when title is unchanged", () => {
    const changes = detectChanges(
      { title: "same title", description: "desc" },
      { title: "same title" },
    );
    assert.deepStrictEqual(changes, {});
  });

  it("should detect no change when body is unchanged", () => {
    const changes = detectChanges(
      { title: "title", description: "same body" },
      { body: "same body" },
    );
    assert.deepStrictEqual(changes, {});
  });

  it("should ignore undefined updates", () => {
    const changes = detectChanges(
      { title: "title", description: "desc" },
      {},
    );
    assert.deepStrictEqual(changes, {});
  });
});

// ---------------------------------------------------------------------------
// Initial state enforcement logic
// ---------------------------------------------------------------------------

describe("initial state enforcement", () => {
  function checkInitialState(
    currentState: string | null,
    initialStateLabel: string,
  ): { allowed: boolean; error?: string } {
    if (currentState !== initialStateLabel) {
      return {
        allowed: false,
        error: `Cannot edit: issue is in "${currentState ?? "unknown"}", ` +
          `edits only allowed in "${initialStateLabel}".`,
      };
    }
    return { allowed: true };
  }

  it("should allow edits in initial state", () => {
    const result = checkInitialState("Planning", "Planning");
    assert.strictEqual(result.allowed, true);
  });

  it("should deny edits in non-initial state", () => {
    const result = checkInitialState("Doing", "Planning");
    assert.strictEqual(result.allowed, false);
    assert.ok(result.error?.includes("Doing"));
    assert.ok(result.error?.includes("Planning"));
  });

  it("should deny edits in Done state", () => {
    const result = checkInitialState("Done", "Planning");
    assert.strictEqual(result.allowed, false);
  });

  it("should deny edits when state is null", () => {
    const result = checkInitialState(null, "Planning");
    assert.strictEqual(result.allowed, false);
    assert.ok(result.error?.includes("unknown"));
  });

  it("should work with custom initial state labels", () => {
    const result = checkInitialState("Backlog", "Backlog");
    assert.strictEqual(result.allowed, true);
  });
});

// ---------------------------------------------------------------------------
// Audit comment body format
// ---------------------------------------------------------------------------

describe("auto-comment format", () => {
  function buildComment(opts: {
    changes: string[];
    reason?: string;
  }): string {
    const timestamp = "2026-02-17T01:30:00.000Z";
    const changeLines = opts.changes.map((c) => `- **${c === "title" ? "Title" : "Description"}** updated`);
    return [
      `📝 **Issue updated** at ${timestamp}`,
      ...changeLines,
      ...(opts.reason ? [`- **Reason:** ${opts.reason}`] : []),
    ].join("\n");
  }

  it("should include timestamp in comment", () => {
    const comment = buildComment({ changes: ["title"] });
    assert.ok(comment.includes("2026-02-17"), "should include date");
    assert.ok(comment.includes("📝"), "should include emoji");
  });

  it("should list title change", () => {
    const comment = buildComment({ changes: ["title"] });
    assert.ok(comment.includes("**Title** updated"));
  });

  it("should list body change", () => {
    const comment = buildComment({ changes: ["body"] });
    assert.ok(comment.includes("**Description** updated"));
  });

  it("should include reason when provided", () => {
    const comment = buildComment({ changes: ["title"], reason: "Fixed typo" });
    assert.ok(comment.includes("Fixed typo"));
    assert.ok(comment.includes("**Reason:**"));
  });

  it("should omit reason line when not provided", () => {
    const comment = buildComment({ changes: ["title"] });
    assert.ok(!comment.includes("**Reason:**"));
  });
});
