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
  developer: {
    id: "developer",
    displayName: "DEVELOPER",
    levels: ["junior", "medior", "senior"],
    defaultLevel: "medior",
    models: {
      junior: "anthropic/claude-haiku-4-5",
      medior: "anthropic/claude-sonnet-4-5",
      senior: "anthropic/claude-opus-4-6",
    },
    emoji: {
      junior: "⚡",
      medior: "🔧",
      senior: "🧠",
    },
    fallbackEmoji: "🔧",
    completionResults: ["done", "review", "blocked"],
    sessionKeyPattern: "developer",
    notifications: { onStart: true, onComplete: true },
  },

  tester: {
    id: "tester",
    displayName: "TESTER",
    levels: ["junior", "medior", "senior"],
    defaultLevel: "medior",
    models: {
      junior: "anthropic/claude-haiku-4-5",
      medior: "anthropic/claude-sonnet-4-5",
      senior: "anthropic/claude-opus-4-6",
    },
    emoji: {
      junior: "⚡",
      medior: "🔍",
      senior: "🧠",
    },
    fallbackEmoji: "🔍",
    completionResults: ["pass", "fail", "refine", "blocked"],
    sessionKeyPattern: "tester",
    notifications: { onStart: true, onComplete: true },
  },

  architect: {
    id: "architect",
    displayName: "ARCHITECT",
    levels: ["junior", "senior"],
    defaultLevel: "junior",
    models: {
      junior: "anthropic/claude-sonnet-4-5",
      senior: "anthropic/claude-opus-4-6",
    },
    emoji: {
      junior: "📐",
      senior: "🏗️",
    },
    fallbackEmoji: "🏗️",
    completionResults: ["done", "blocked"],
    sessionKeyPattern: "architect",
    notifications: { onStart: true, onComplete: true },
  },
};
