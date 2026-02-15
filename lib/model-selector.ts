/**
 * Model selection for dev/qa tasks.
 * Keyword heuristic fallback — used when the orchestrator doesn't specify a level.
 * Returns plain level names (junior, mid, senior).
 */

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
 * Select appropriate developer level based on task description.
 *
 * All roles use consistent levels:
 * - junior: simple tasks (typos, single-file fixes, CSS tweaks)
 * - mid: standard work (features, bug fixes, multi-file changes)
 * - senior: deep/architectural (system-wide refactoring, novel design)
 */
export function selectLevel(
  issueTitle: string,
  issueDescription: string,
  role: "dev" | "qa" | "architect",
): LevelSelection {
  if (role === "qa") {
    return {
      level: "mid",
      reason: "Default QA level for code inspection and validation",
    };
  }

  if (role === "architect") {
    const text = `${issueTitle} ${issueDescription}`.toLowerCase();
    const isComplex = COMPLEX_KEYWORDS.some((kw) => text.includes(kw));
    return {
      level: isComplex ? "senior" : "junior",
      reason: isComplex
        ? "Complex design task — using senior for depth"
        : "Standard design task — using junior",
    };
  }

  const text = `${issueTitle} ${issueDescription}`.toLowerCase();
  const wordCount = text.split(/\s+/).length;

  // Check for simple task indicators
  const isSimple = SIMPLE_KEYWORDS.some((kw) => text.includes(kw));
  if (isSimple && wordCount < 100) {
    return {
      level: "junior",
      reason: `Simple task detected (keywords: ${SIMPLE_KEYWORDS.filter((kw) => text.includes(kw)).join(", ")})`,
    };
  }

  // Check for complex task indicators
  const isComplex = COMPLEX_KEYWORDS.some((kw) => text.includes(kw));
  if (isComplex || wordCount > 500) {
    return {
      level: "senior",
      reason: `Complex task detected (${isComplex ? "keywords: " + COMPLEX_KEYWORDS.filter((kw) => text.includes(kw)).join(", ") : "long description"})`,
    };
  }

  // Default: mid for standard dev work
  return {
    level: "mid",
    reason: "Standard dev task — multi-file changes, features, bug fixes",
  };
}
