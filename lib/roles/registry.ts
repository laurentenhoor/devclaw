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
    levels: ["junior", "mid", "senior"],
    defaultLevel: "mid",
    models: {
      junior: "anthropic/claude-haiku-4-5",
      mid: "anthropic/claude-sonnet-4-5",
      senior: "anthropic/claude-opus-4-5",
    },
    emoji: {
      junior: "⚡",
      mid: "🔧",
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
    levels: ["junior", "mid", "senior"],
    defaultLevel: "mid",
    models: {
      junior: "anthropic/claude-haiku-4-5",
      mid: "anthropic/claude-sonnet-4-5",
      senior: "anthropic/claude-opus-4-5",
    },
    emoji: {
      junior: "⚡",
      mid: "🔍",
      senior: "🧠",
    },
    fallbackEmoji: "🔍",
    completionResults: ["pass", "fail", "refine", "blocked"],
    sessionKeyPattern: "qa",
    notifications: { onStart: true, onComplete: true },
  },

  architect: {
    id: "architect",
    displayName: "ARCHITECT",
    levels: ["junior", "senior"],
    defaultLevel: "junior",
    models: {
      junior: "anthropic/claude-sonnet-4-5",
      senior: "anthropic/claude-opus-4-5",
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
