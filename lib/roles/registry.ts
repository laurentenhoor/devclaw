/**
 * roles/registry.ts — Single source of truth for all worker roles.
 *
 * Adding a new role? Just add an entry here. Everything else derives from this.
 *
 * Each role defines:
 * - Identity (id, displayName)
 * - Levels and models
 * - Emoji for announcements
 * - Valid completion results
 * - Session key matching
 * - Notification preferences
 */
import type { RoleConfig } from "./types.js";

export const ROLE_REGISTRY: Record<string, RoleConfig> = {
  dev: {
    id: "dev",
    displayName: "DEV",
    levels: ["junior", "medior", "senior"],
    defaultLevel: "medior",
    models: {
      junior: "anthropic/claude-haiku-4-5",
      medior: "anthropic/claude-sonnet-4-5",
      senior: "anthropic/claude-opus-4-5",
    },
    emoji: {
      junior: "⚡",
      medior: "🔧",
      senior: "🧠",
    },
    fallbackEmoji: "🔧",
    completionResults: ["done", "blocked"],
    sessionKeyPattern: "dev",
    notifications: { onStart: true, onComplete: true },
  },

  qa: {
    id: "qa",
    displayName: "QA",
    levels: ["reviewer", "tester"],
    defaultLevel: "reviewer",
    models: {
      reviewer: "anthropic/claude-sonnet-4-5",
      tester: "anthropic/claude-haiku-4-5",
    },
    emoji: {
      reviewer: "🔍",
      tester: "👀",
    },
    fallbackEmoji: "🔍",
    completionResults: ["pass", "fail", "refine", "blocked"],
    sessionKeyPattern: "qa",
    notifications: { onStart: true, onComplete: true },
  },

  architect: {
    id: "architect",
    displayName: "ARCHITECT",
    levels: ["opus", "sonnet"],
    defaultLevel: "sonnet",
    models: {
      opus: "anthropic/claude-opus-4-5",
      sonnet: "anthropic/claude-sonnet-4-5",
    },
    emoji: {
      opus: "🏗️",
      sonnet: "📐",
    },
    fallbackEmoji: "🏗️",
    completionResults: ["done", "blocked"],
    sessionKeyPattern: "architect",
    notifications: { onStart: true, onComplete: true },
  },
};
