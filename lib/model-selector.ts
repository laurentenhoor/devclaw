/**
 * Model selection for dev/qa tasks.
 * Keyword heuristic fallback — used when the orchestrator doesn't specify a tier.
 * Returns tier names (junior, medior, senior, qa) instead of model aliases.
 */

export type TierRecommendation = {
  tier: string;
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
 * Select appropriate developer tier based on task description.
 *
 * Developer tiers:
 * - junior: very simple (typos, single-file fixes, CSS tweaks)
 * - medior: standard DEV (features, bug fixes, multi-file changes)
 * - senior: deep/architectural (system-wide refactoring, novel design)
 * - qa: all QA tasks (code inspection, validation, test runs)
 */
export function selectTier(
  issueTitle: string,
  issueDescription: string,
  role: "dev" | "qa",
): TierRecommendation {
  if (role === "qa") {
    return {
      tier: "qa",
      reason: "Default QA tier for code inspection and validation",
    };
  }

  const text = `${issueTitle} ${issueDescription}`.toLowerCase();
  const wordCount = text.split(/\s+/).length;

  // Check for simple task indicators
  const isSimple = SIMPLE_KEYWORDS.some((kw) => text.includes(kw));
  if (isSimple && wordCount < 100) {
    return {
      tier: "junior",
      reason: `Simple task detected (keywords: ${SIMPLE_KEYWORDS.filter((kw) => text.includes(kw)).join(", ")})`,
    };
  }

  // Check for complex task indicators
  const isComplex = COMPLEX_KEYWORDS.some((kw) => text.includes(kw));
  if (isComplex || wordCount > 500) {
    return {
      tier: "senior",
      reason: `Complex task detected (${isComplex ? "keywords: " + COMPLEX_KEYWORDS.filter((kw) => text.includes(kw)).join(", ") : "long description"})`,
    };
  }

  // Default: medior for standard dev work
  return {
    tier: "medior",
    reason: "Standard dev task — multi-file changes, features, bug fixes",
  };
}
