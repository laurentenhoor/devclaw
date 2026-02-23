import { describe, it, expect } from "vitest";
import { nameFromSeed, slotName, NAMES } from "./names.js";

describe("NAMES pool", () => {
  it("has enough names to be collision-resistant", () => {
    expect(NAMES.length).toBeGreaterThan(1000);
  });
});

describe("nameFromSeed", () => {
  it("is deterministic — same seed always returns same name", () => {
    const a = nameFromSeed("test-seed");
    const b = nameFromSeed("test-seed");
    expect(a).toBe(b);
  });

  it("returns different names for different seeds", () => {
    const a = nameFromSeed("seed-a");
    const b = nameFromSeed("seed-b");
    // Could theoretically collide but extremely unlikely with different seeds
    expect(a).not.toBe(b);
  });

  it("returns a name from the NAMES list", () => {
    const name = nameFromSeed("any-seed");
    expect(NAMES).toContain(name);
  });

  it("handles empty string seed", () => {
    const name = nameFromSeed("");
    expect(NAMES).toContain(name);
  });
});

describe("slotName", () => {
  it("is deterministic for the same slot coordinates", () => {
    const a = slotName("myapp", "developer", "medior", 0);
    const b = slotName("myapp", "developer", "medior", 0);
    expect(a).toBe(b);
  });

  it("returns different names for different slot indices", () => {
    const a = slotName("myapp", "developer", "medior", 0);
    const b = slotName("myapp", "developer", "medior", 1);
    expect(a).not.toBe(b);
  });

  it("returns different names for different roles", () => {
    const a = slotName("myapp", "developer", "medior", 0);
    const b = slotName("myapp", "tester", "medior", 0);
    expect(a).not.toBe(b);
  });

  it("returns different names for different projects", () => {
    const a = slotName("project-a", "developer", "medior", 0);
    const b = slotName("project-b", "developer", "medior", 0);
    expect(a).not.toBe(b);
  });

  it("produces no collisions for typical slot counts within a project", () => {
    const names = new Set<string>();
    const roles = ["developer", "tester", "reviewer"];
    const levels = ["junior", "medior", "senior"];
    for (const role of roles) {
      for (const level of levels) {
        for (let i = 0; i < 3; i++) {
          names.add(`${role}:${level}:${slotName("myapp", role, level, i)}`);
        }
      }
    }
    // 3 roles × 3 levels × 3 slots = 27 — all should be unique
    expect(names.size).toBe(27);
  });
});
