/**
 * Developer tier definitions and model resolution.
 *
 * Tasks are assigned to developer tiers (junior, medior, senior, qa)
 * instead of raw model names. Each tier maps to a configurable LLM model.
 */

export const DEV_TIERS = ["junior", "medior", "senior"] as const;
export const QA_TIERS = ["qa"] as const;
export const ALL_TIERS = [...DEV_TIERS, ...QA_TIERS] as const;

export type DevTier = (typeof DEV_TIERS)[number];
export type QaTier = (typeof QA_TIERS)[number];
export type Tier = (typeof ALL_TIERS)[number];

export const DEFAULT_MODELS: Record<Tier, string> = {
  junior: "anthropic/claude-haiku-4-5",
  medior: "anthropic/claude-sonnet-4-5",
  senior: "anthropic/claude-opus-4-5",
  qa: "anthropic/claude-sonnet-4-5",
};

/** Emoji used in announcements per tier. */
export const TIER_EMOJI: Record<Tier, string> = {
  junior: "⚡",
  medior: "🔧",
  senior: "🧠",
  qa: "🔍",
};

/** Check if a string is a valid tier name. */
export function isTier(value: string): value is Tier {
  return (ALL_TIERS as readonly string[]).includes(value);
}

/** Check if a string is a valid dev tier name. */
export function isDevTier(value: string): value is DevTier {
  return (DEV_TIERS as readonly string[]).includes(value);
}

/**
 * Resolve a tier name to a full model ID.
 *
 * Resolution order:
 * 1. Plugin config `models` map (user overrides)
 * 2. DEFAULT_MODELS (hardcoded defaults)
 * 3. Treat input as raw model ID (passthrough for non-tier values)
 */
export function resolveTierToModel(
  tier: string,
  pluginConfig?: Record<string, unknown>,
): string {
  const models = (pluginConfig as { models?: Record<string, string> })?.models;
  return models?.[tier] ?? DEFAULT_MODELS[tier as Tier] ?? tier;
}

/**
 * Migration map from old model-alias session keys to tier names.
 * Used by migrateWorkerState() in projects.ts.
 */
export const TIER_MIGRATION: Record<string, string> = {
  haiku: "junior",
  sonnet: "medior",
  opus: "senior",
  grok: "qa",
};
