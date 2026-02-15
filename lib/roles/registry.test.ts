/**
 * Tests for centralized role registry.
 * Run with: npx tsx --test lib/roles/registry.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import {
  ROLE_REGISTRY,
  getAllRoleIds,
  isValidRole,
  getRole,
  requireRole,
  getLevelsForRole,
  getAllLevels,
  isLevelForRole,
  roleForLevel,
  getDefaultLevel,
  getDefaultModel,
  getAllDefaultModels,
  resolveModel,
  canonicalLevel,
  getEmoji,
  getFallbackEmoji,
  getCompletionResults,
  isValidResult,
  getSessionKeyRolePattern,
} from "./index.js";

describe("role registry", () => {
  it("should have all expected roles", () => {
    const ids = getAllRoleIds();
    assert.ok(ids.includes("developer"));
    assert.ok(ids.includes("tester"));
    assert.ok(ids.includes("architect"));
  });

  it("should validate role IDs", () => {
    assert.strictEqual(isValidRole("developer"), true);
    assert.strictEqual(isValidRole("tester"), true);
    assert.strictEqual(isValidRole("architect"), true);
    assert.strictEqual(isValidRole("nonexistent"), false);
  });

  it("should get role config", () => {
    const dev = getRole("developer");
    assert.ok(dev);
    assert.strictEqual(dev.id, "developer");
    assert.strictEqual(dev.displayName, "DEVELOPER");
  });

  it("should throw for unknown role in requireRole", () => {
    assert.throws(() => requireRole("nonexistent"), /Unknown role/);
  });
});

describe("levels", () => {
  it("should return levels for each role", () => {
    assert.deepStrictEqual([...getLevelsForRole("developer")], ["junior", "medior", "senior"]);
    assert.deepStrictEqual([...getLevelsForRole("tester")], ["junior", "medior", "senior"]);
    assert.deepStrictEqual([...getLevelsForRole("architect")], ["junior", "senior"]);
  });

  it("should return empty for unknown role", () => {
    assert.deepStrictEqual([...getLevelsForRole("nonexistent")], []);
  });

  it("should return all levels", () => {
    const all = getAllLevels();
    assert.ok(all.includes("junior"));
    assert.ok(all.includes("medior"));
    assert.ok(all.includes("senior"));
  });

  it("should check level membership", () => {
    assert.strictEqual(isLevelForRole("junior", "developer"), true);
    assert.strictEqual(isLevelForRole("junior", "tester"), true);
    assert.strictEqual(isLevelForRole("junior", "architect"), true);
    assert.strictEqual(isLevelForRole("medior", "developer"), true);
    assert.strictEqual(isLevelForRole("medior", "architect"), false);
  });

  it("should find role for level", () => {
    // "junior" appears in developer first (registry order)
    assert.strictEqual(roleForLevel("junior"), "developer");
    assert.strictEqual(roleForLevel("medior"), "developer");
    assert.strictEqual(roleForLevel("senior"), "developer");
    assert.strictEqual(roleForLevel("nonexistent"), undefined);
  });

  it("should return default level", () => {
    assert.strictEqual(getDefaultLevel("developer"), "medior");
    assert.strictEqual(getDefaultLevel("tester"), "medior");
    assert.strictEqual(getDefaultLevel("architect"), "junior");
  });
});

describe("level aliases", () => {
  it("should map old developer level names", () => {
    assert.strictEqual(canonicalLevel("developer", "mid"), "medior");
    assert.strictEqual(canonicalLevel("developer", "junior"), "junior");
    assert.strictEqual(canonicalLevel("developer", "senior"), "senior");
  });

  it("should map old dev role level names", () => {
    assert.strictEqual(canonicalLevel("dev", "mid"), "medior");
    assert.strictEqual(canonicalLevel("dev", "medior"), "medior");
  });

  it("should map old qa/tester level names", () => {
    assert.strictEqual(canonicalLevel("tester", "mid"), "medior");
    assert.strictEqual(canonicalLevel("tester", "reviewer"), "medior");
    assert.strictEqual(canonicalLevel("qa", "reviewer"), "medior");
    assert.strictEqual(canonicalLevel("qa", "tester"), "junior");
  });

  it("should map old architect level names", () => {
    assert.strictEqual(canonicalLevel("architect", "opus"), "senior");
    assert.strictEqual(canonicalLevel("architect", "sonnet"), "junior");
  });

  it("should pass through unknown levels", () => {
    assert.strictEqual(canonicalLevel("developer", "custom"), "custom");
    assert.strictEqual(canonicalLevel("unknown", "whatever"), "whatever");
  });
});

describe("models", () => {
  it("should return default models", () => {
    assert.strictEqual(getDefaultModel("developer", "junior"), "anthropic/claude-haiku-4-5");
    assert.strictEqual(getDefaultModel("developer", "medior"), "anthropic/claude-sonnet-4-5");
    assert.strictEqual(getDefaultModel("tester", "medior"), "anthropic/claude-sonnet-4-5");
    assert.strictEqual(getDefaultModel("architect", "senior"), "anthropic/claude-opus-4-6");
  });

  it("should return all default models", () => {
    const models = getAllDefaultModels();
    assert.ok(models.developer);
    assert.ok(models.tester);
    assert.ok(models.architect);
    assert.strictEqual(models.developer.junior, "anthropic/claude-haiku-4-5");
  });

  it("should resolve from resolved role config override", () => {
    const resolvedRole = { models: { junior: "custom/model" }, levels: ["junior", "medior", "senior"], defaultLevel: "medior", emoji: {}, completionResults: [] as string[], enabled: true };
    assert.strictEqual(resolveModel("developer", "junior", resolvedRole), "custom/model");
  });

  it("should fall back to default", () => {
    assert.strictEqual(resolveModel("developer", "junior"), "anthropic/claude-haiku-4-5");
  });

  it("should pass through unknown level as model ID", () => {
    assert.strictEqual(resolveModel("developer", "anthropic/claude-opus-4-6"), "anthropic/claude-opus-4-6");
  });

  it("should resolve via level aliases", () => {
    // "mid" alias maps to "medior" — should resolve to default medior model
    assert.strictEqual(resolveModel("developer", "mid"), "anthropic/claude-sonnet-4-5");
    // With explicit override in resolved config
    const resolvedRole = { models: { medior: "custom/old-config-model" }, levels: ["junior", "medior", "senior"], defaultLevel: "medior", emoji: {}, completionResults: [] as string[], enabled: true };
    assert.strictEqual(resolveModel("developer", "mid", resolvedRole), "custom/old-config-model");
  });

  it("should resolve with resolved role overriding defaults selectively", () => {
    const resolvedRole = { models: { junior: "custom/model" }, levels: ["junior", "medior", "senior"], defaultLevel: "medior", emoji: {}, completionResults: [] as string[], enabled: true };
    assert.strictEqual(resolveModel("developer", "junior", resolvedRole), "custom/model");
    // Levels not overridden fall through to registry defaults
    assert.strictEqual(resolveModel("developer", "medior", resolvedRole), "anthropic/claude-sonnet-4-5");
  });
});

describe("emoji", () => {
  it("should return level emoji", () => {
    assert.strictEqual(getEmoji("developer", "junior"), "⚡");
    assert.strictEqual(getEmoji("architect", "senior"), "🏗️");
  });

  it("should return fallback emoji", () => {
    assert.strictEqual(getFallbackEmoji("developer"), "🔧");
    assert.strictEqual(getFallbackEmoji("tester"), "🔍");
    assert.strictEqual(getFallbackEmoji("architect"), "🏗️");
    assert.strictEqual(getFallbackEmoji("nonexistent"), "📋");
  });
});

describe("completion results", () => {
  it("should return valid results per role", () => {
    assert.deepStrictEqual([...getCompletionResults("developer")], ["done", "blocked"]);
    assert.deepStrictEqual([...getCompletionResults("tester")], ["pass", "fail", "refine", "blocked"]);
    assert.deepStrictEqual([...getCompletionResults("architect")], ["done", "blocked"]);
  });

  it("should validate results", () => {
    assert.strictEqual(isValidResult("developer", "done"), true);
    assert.strictEqual(isValidResult("developer", "pass"), false);
    assert.strictEqual(isValidResult("tester", "pass"), true);
    assert.strictEqual(isValidResult("tester", "done"), false);
  });
});

describe("session key pattern", () => {
  it("should generate pattern matching all roles", () => {
    const pattern = getSessionKeyRolePattern();
    assert.ok(pattern.includes("developer"));
    assert.ok(pattern.includes("tester"));
    assert.ok(pattern.includes("architect"));
  });

  it("should work as regex", () => {
    const pattern = getSessionKeyRolePattern();
    const regex = new RegExp(`(${pattern})`);
    assert.ok(regex.test("developer"));
    assert.ok(regex.test("tester"));
    assert.ok(regex.test("architect"));
    assert.ok(!regex.test("nonexistent"));
  });
});

describe("registry consistency", () => {
  it("every role should have all required fields", () => {
    for (const [id, config] of Object.entries(ROLE_REGISTRY)) {
      assert.strictEqual(config.id, id, `${id}: id mismatch`);
      assert.ok(config.displayName, `${id}: missing displayName`);
      assert.ok(config.levels.length > 0, `${id}: empty levels`);
      assert.ok(config.levels.includes(config.defaultLevel), `${id}: defaultLevel not in levels`);
      assert.ok(config.completionResults.length > 0, `${id}: empty completionResults`);
      assert.ok(config.fallbackEmoji, `${id}: missing fallbackEmoji`);

      // Every level should have a model
      for (const level of config.levels) {
        assert.ok(config.models[level], `${id}: missing model for level "${level}"`);
      }

      // Every level should have an emoji
      for (const level of config.levels) {
        assert.ok(config.emoji[level], `${id}: missing emoji for level "${level}"`);
      }
    }
  });
});
