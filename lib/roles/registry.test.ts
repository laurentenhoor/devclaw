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
    assert.ok(ids.includes("dev"));
    assert.ok(ids.includes("qa"));
    assert.ok(ids.includes("architect"));
  });

  it("should validate role IDs", () => {
    assert.strictEqual(isValidRole("dev"), true);
    assert.strictEqual(isValidRole("qa"), true);
    assert.strictEqual(isValidRole("architect"), true);
    assert.strictEqual(isValidRole("nonexistent"), false);
  });

  it("should get role config", () => {
    const dev = getRole("dev");
    assert.ok(dev);
    assert.strictEqual(dev.id, "dev");
    assert.strictEqual(dev.displayName, "DEV");
  });

  it("should throw for unknown role in requireRole", () => {
    assert.throws(() => requireRole("nonexistent"), /Unknown role/);
  });
});

describe("levels", () => {
  it("should return levels for each role", () => {
    assert.deepStrictEqual([...getLevelsForRole("dev")], ["junior", "mid", "senior"]);
    assert.deepStrictEqual([...getLevelsForRole("qa")], ["junior", "mid", "senior"]);
    assert.deepStrictEqual([...getLevelsForRole("architect")], ["junior", "senior"]);
  });

  it("should return empty for unknown role", () => {
    assert.deepStrictEqual([...getLevelsForRole("nonexistent")], []);
  });

  it("should return all levels", () => {
    const all = getAllLevels();
    assert.ok(all.includes("junior"));
    assert.ok(all.includes("mid"));
    assert.ok(all.includes("senior"));
  });

  it("should check level membership", () => {
    assert.strictEqual(isLevelForRole("junior", "dev"), true);
    assert.strictEqual(isLevelForRole("junior", "qa"), true);
    assert.strictEqual(isLevelForRole("junior", "architect"), true);
    assert.strictEqual(isLevelForRole("mid", "dev"), true);
    assert.strictEqual(isLevelForRole("mid", "architect"), false);
  });

  it("should find role for level", () => {
    // "junior" appears in dev first (registry order)
    assert.strictEqual(roleForLevel("junior"), "dev");
    assert.strictEqual(roleForLevel("mid"), "dev");
    assert.strictEqual(roleForLevel("senior"), "dev");
    assert.strictEqual(roleForLevel("nonexistent"), undefined);
  });

  it("should return default level", () => {
    assert.strictEqual(getDefaultLevel("dev"), "mid");
    assert.strictEqual(getDefaultLevel("qa"), "mid");
    assert.strictEqual(getDefaultLevel("architect"), "junior");
  });
});

describe("level aliases", () => {
  it("should map old dev level names", () => {
    assert.strictEqual(canonicalLevel("dev", "medior"), "mid");
    assert.strictEqual(canonicalLevel("dev", "junior"), "junior");
    assert.strictEqual(canonicalLevel("dev", "senior"), "senior");
  });

  it("should map old qa level names", () => {
    assert.strictEqual(canonicalLevel("qa", "reviewer"), "mid");
    assert.strictEqual(canonicalLevel("qa", "tester"), "junior");
  });

  it("should map old architect level names", () => {
    assert.strictEqual(canonicalLevel("architect", "opus"), "senior");
    assert.strictEqual(canonicalLevel("architect", "sonnet"), "junior");
  });

  it("should pass through unknown levels", () => {
    assert.strictEqual(canonicalLevel("dev", "custom"), "custom");
    assert.strictEqual(canonicalLevel("unknown", "whatever"), "whatever");
  });
});

describe("models", () => {
  it("should return default models", () => {
    assert.strictEqual(getDefaultModel("dev", "junior"), "anthropic/claude-haiku-4-5");
    assert.strictEqual(getDefaultModel("dev", "mid"), "anthropic/claude-sonnet-4-5");
    assert.strictEqual(getDefaultModel("qa", "mid"), "anthropic/claude-sonnet-4-5");
    assert.strictEqual(getDefaultModel("architect", "senior"), "anthropic/claude-opus-4-5");
  });

  it("should return all default models", () => {
    const models = getAllDefaultModels();
    assert.ok(models.dev);
    assert.ok(models.qa);
    assert.ok(models.architect);
    assert.strictEqual(models.dev.junior, "anthropic/claude-haiku-4-5");
  });

  it("should resolve from config override", () => {
    const config = { models: { dev: { junior: "custom/model" } } };
    assert.strictEqual(resolveModel("dev", "junior", config), "custom/model");
  });

  it("should fall back to default", () => {
    assert.strictEqual(resolveModel("dev", "junior"), "anthropic/claude-haiku-4-5");
  });

  it("should pass through unknown level as model ID", () => {
    assert.strictEqual(resolveModel("dev", "anthropic/claude-opus-4-5"), "anthropic/claude-opus-4-5");
  });

  it("should resolve old config keys via aliases", () => {
    // Old config uses "medior" key — should still resolve
    const config = { models: { dev: { medior: "custom/old-config-model" } } };
    assert.strictEqual(resolveModel("dev", "medior", config), "custom/old-config-model");
    // Also works when requesting the canonical name
    assert.strictEqual(resolveModel("dev", "mid", {}), "anthropic/claude-sonnet-4-5");
  });

  it("should resolve old qa config keys", () => {
    const config = { models: { qa: { reviewer: "custom/qa-model" } } };
    assert.strictEqual(resolveModel("qa", "reviewer", config), "custom/qa-model");
  });
});

describe("emoji", () => {
  it("should return level emoji", () => {
    assert.strictEqual(getEmoji("dev", "junior"), "⚡");
    assert.strictEqual(getEmoji("architect", "senior"), "🏗️");
  });

  it("should return fallback emoji", () => {
    assert.strictEqual(getFallbackEmoji("dev"), "🔧");
    assert.strictEqual(getFallbackEmoji("qa"), "🔍");
    assert.strictEqual(getFallbackEmoji("architect"), "🏗️");
    assert.strictEqual(getFallbackEmoji("nonexistent"), "📋");
  });
});

describe("completion results", () => {
  it("should return valid results per role", () => {
    assert.deepStrictEqual([...getCompletionResults("dev")], ["done", "blocked"]);
    assert.deepStrictEqual([...getCompletionResults("qa")], ["pass", "fail", "refine", "blocked"]);
    assert.deepStrictEqual([...getCompletionResults("architect")], ["done", "blocked"]);
  });

  it("should validate results", () => {
    assert.strictEqual(isValidResult("dev", "done"), true);
    assert.strictEqual(isValidResult("dev", "pass"), false);
    assert.strictEqual(isValidResult("qa", "pass"), true);
    assert.strictEqual(isValidResult("qa", "done"), false);
  });
});

describe("session key pattern", () => {
  it("should generate pattern matching all roles", () => {
    const pattern = getSessionKeyRolePattern();
    assert.ok(pattern.includes("dev"));
    assert.ok(pattern.includes("qa"));
    assert.ok(pattern.includes("architect"));
  });

  it("should work as regex", () => {
    const pattern = getSessionKeyRolePattern();
    const regex = new RegExp(`(${pattern})`);
    assert.ok(regex.test("dev"));
    assert.ok(regex.test("qa"));
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
