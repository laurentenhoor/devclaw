/**
 * Model selection heuristic fallback — used when the orchestrator doesn't specify a level.
 * Returns plain level names (junior, medior, senior).
 *
 * Adapts to any role's level count:
 * - 1 level: always returns that level
 * - 2 levels: simple binary (complex → last, else first)
 * - 3+ levels: full heuristic (simple → first, complex → last, default → middle)
 */
import { getLevelsForRole, getDefaultLevel } from "./index.js";

export type LevelSelection = {
  level: string;
  reason: string;
};

// Keywords that indicate simple tasks
const SIMPLE_KEYWORDS = [
  "typo",
  "fix typo",
  "rename",
  "update text",
  "change color",
  "minor",
  "small",
  "css",
  "style",
  "copy",
  "wording",
];

// Keywords that indicate complex tasks
const COMPLEX_KEYWORDS = [
  "architect",
  "refactor",
  "redesign",
  "system-wide",
  "migration",
  "database schema",
  "security",
  "performance",
  "infrastructure",
  "multi-service",
];

/**
 * Select appropriate level based on task description and role.
 *
 * Adapts to the role's available levels:
 * - Roles with 1 level → always that level
 * - Roles with 2 levels → binary: complex keywords → highest, else lowest
 * - Roles with 3+ levels → full heuristic: simple → lowest, complex → highest, else default
 */
export function selectLevel(
  issueTitle: string,
  issueDescription: string,
  role: string,
): LevelSelection {
  const levels = getLevelsForRole(role);
  const defaultLvl = getDefaultLevel(role);

  // Roles with only 1 level — always return it
  if (levels.length <= 1) {
    const level = levels[0] ?? defaultLvl ?? "medior";
    return { level, reason: `Only level for ${role}` };
  }

  const text = `${issueTitle} ${issueDescription}`.toLowerCase();
  const wordCount = text.split(/\s+/).length;
  const isSimple = SIMPLE_KEYWORDS.some((kw) => text.includes(kw));
  const isComplex = COMPLEX_KEYWORDS.some((kw) => text.includes(kw));

  const lowest = levels[0];
  const highest = levels[levels.length - 1];

  // Roles with 2 levels — binary decision
  if (levels.length === 2) {
    if (isComplex) {
      return { level: highest, reason: `Complex task — using ${highest}` };
    }
    return { level: lowest, reason: `Standard task — using ${lowest}` };
  }

  // Roles with 3+ levels — full heuristic
  if (isSimple && wordCount < 100) {
    return {
      level: lowest,
      reason: `Simple task detected (keywords: ${SIMPLE_KEYWORDS.filter((kw) => text.includes(kw)).join(", ")})`,
    };
  }

  if (isComplex || wordCount > 500) {
    return {
      level: highest,
      reason: `Complex task detected (${isComplex ? "keywords: " + COMPLEX_KEYWORDS.filter((kw) => text.includes(kw)).join(", ") : "long description"})`,
    };
  }

  // Default level for the role
  const level = defaultLvl ?? levels[Math.floor(levels.length / 2)];
  return { level, reason: `Standard ${role} task` };
}
