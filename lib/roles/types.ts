/**
 * roles/types.ts — Type definitions for the role registry.
 *
 * RoleConfig is the single interface describing everything about a role.
 * All role-related behavior should be derived from this config.
 */

/** Configuration for a single worker role. */
export type RoleConfig = {
  /** Unique role identifier (e.g., "dev", "qa", "architect"). */
  id: string;
  /** Human-readable display name. */
  displayName: string;
  /** Valid levels for this role. */
  levels: readonly string[];
  /** Default level when none specified. */
  defaultLevel: string;
  /** Default model per level. */
  models: Record<string, string>;
  /** Emoji per level (used in announcements). */
  emoji: Record<string, string>;
  /** Fallback emoji when level-specific emoji not found. */
  fallbackEmoji: string;
  /** Valid completion results for this role. */
  completionResults: readonly string[];
  /** Regex pattern fragment for session key matching (e.g., "dev|qa|architect"). */
  sessionKeyPattern: string;
  /** Notification config per event type. */
  notifications: {
    onStart: boolean;
    onComplete: boolean;
  };
};

/** A role ID string (typed from registry keys). */
export type RoleId = string;
