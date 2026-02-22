/**
 * migrations.ts — Backward-compatibility aliases and migration logic.
 *
 * Contains all role/level renaming aliases and projects.json format migration.
 * This file can be removed once all users have migrated to the new format.
 *
 * Migrations handled:
 * - Role renames: dev → developer, qa → tester
 * - Level renames: mid → medior, reviewer → medior, tester → junior, opus → senior, sonnet → junior
 * - projects.json format: old hardcoded dev/qa/architect fields → workers map
 * - projects.json format: old role keys in workers map → canonical role keys
 */

import type { LegacyWorkerState, RoleWorkerState, Project } from "./projects.js";
import { emptyRoleWorkerState, emptySlot } from "./projects.js";

// ---------------------------------------------------------------------------
// Role aliases — old role IDs → canonical IDs
// ---------------------------------------------------------------------------

/** Maps old role IDs to canonical IDs. */
export const ROLE_ALIASES: Record<string, string> = {
  dev: "developer",
  qa: "tester",
};

/** Resolve a role ID, applying aliases for backward compatibility. */
export function canonicalRole(role: string): string {
  return ROLE_ALIASES[role] ?? role;
}

// ---------------------------------------------------------------------------
// Level aliases — old level names → canonical names, per role
// ---------------------------------------------------------------------------

/** Maps old level names to canonical names, per role. */
export const LEVEL_ALIASES: Record<string, Record<string, string>> = {
  developer: { mid: "medior", medior: "medior" },
  dev: { mid: "medior", medior: "medior" },
  tester: { mid: "medior", reviewer: "medior", tester: "junior" },
  qa: { mid: "medior", reviewer: "medior", tester: "junior" },
  architect: { opus: "senior", sonnet: "junior" },
};

/** Resolve a level name, applying aliases for backward compatibility. */
export function canonicalLevel(role: string, level: string): string {
  return LEVEL_ALIASES[role]?.[level] ?? level;
}

// ---------------------------------------------------------------------------
// projects.json migration helpers
// ---------------------------------------------------------------------------

function migrateLevel(level: string | null, role: string): string | null {
  if (!level) return null;
  return LEVEL_ALIASES[role]?.[level] ?? level;
}

function migrateSessions(
  sessions: Record<string, string | null>,
  role: string,
): Record<string, string | null> {
  const aliases = LEVEL_ALIASES[role];
  if (!aliases) return sessions;

  const migrated: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(sessions)) {
    const newKey = aliases[key] ?? key;
    migrated[newKey] = value;
  }
  return migrated;
}

/**
 * Detect if a worker object is in the legacy (flat) format.
 * Legacy format has `active` at top level and no `slots` array.
 */
function isLegacyWorkerFormat(worker: Record<string, unknown>): boolean {
  return "active" in worker && !("slots" in worker);
}

/**
 * Parse a legacy flat worker state into a RoleWorkerState with one slot.
 * Extracts sessionKey from sessions[level].
 */
function parseLegacyWorkerState(worker: Record<string, unknown>, role: string): RoleWorkerState {
  const level = (worker.level ?? worker.tier ?? null) as string | null;
  const migratedLevel = migrateLevel(level, role);
  const sessions = (worker.sessions as Record<string, string | null>) ?? {};
  const migratedSessions = migrateSessions(sessions, role);
  
  // Extract sessionKey: prefer sessions[level], fall back to first non-null
  let sessionKey: string | null = null;
  if (migratedLevel && migratedSessions[migratedLevel]) {
    sessionKey = migratedSessions[migratedLevel]!;
  } else {
    const firstNonNull = Object.values(migratedSessions).find(v => v != null);
    if (firstNonNull) sessionKey = firstNonNull;
  }

  return {
    maxWorkers: 1,
    slots: [{
      active: worker.active as boolean,
      issueId: worker.issueId as string | null,
      level: migratedLevel,
      sessionKey,
      startTime: worker.startTime as string | null,
      previousLabel: (worker.previousLabel as string | null) ?? null,
    }],
  };
}

/**
 * Parse a worker object that's already in the new slot-based format,
 * applying level migration to each slot.
 */
function parseSlotWorkerState(worker: Record<string, unknown>, role: string): RoleWorkerState {
  const maxWorkers = (worker.maxWorkers as number) ?? 1;
  const rawSlots = (worker.slots as Array<Record<string, unknown>>) ?? [];
  const slots: import("./projects.js").SlotState[] = rawSlots.map(s => ({
    active: s.active as boolean,
    issueId: s.issueId as string | null,
    level: migrateLevel(s.level as string | null, role),
    sessionKey: s.sessionKey as string | null,
    startTime: s.startTime as string | null,
    previousLabel: (s.previousLabel as string | null) ?? null,
  }));
  // Ensure we have at least maxWorkers slots
  while (slots.length < maxWorkers) {
    slots.push(emptySlot());
  }
  return { maxWorkers, slots };
}

function parseWorkerState(worker: Record<string, unknown>, role: string): RoleWorkerState {
  if (isLegacyWorkerFormat(worker)) {
    return parseLegacyWorkerState(worker, role);
  }
  return parseSlotWorkerState(worker, role);
}

/**
 * Migrate a raw project object from old format to current format.
 *
 * Handles:
 * 1. Old format: hardcoded dev/qa/architect fields → workers map
 * 2. Old role keys in workers map (dev → developer, qa → tester)
 * 3. Old level names in worker state
 * 4. Missing channel field defaults to "telegram"
 */
export function migrateProject(project: Project): void {
  const raw = project as unknown as Record<string, unknown>;

  if (!raw.workers && (raw.dev || raw.qa || raw.architect)) {
    // Old format: hardcoded dev/qa/architect fields → workers map
    project.workers = {};
    for (const role of ["dev", "qa", "architect"]) {
      const canonical = ROLE_ALIASES[role] ?? role;
      project.workers[canonical] = raw[role]
        ? parseWorkerState(raw[role] as Record<string, unknown>, role)
        : emptyRoleWorkerState(1);
    }
    // Clean up old fields from the in-memory object
    delete raw.dev;
    delete raw.qa;
    delete raw.architect;
  } else if (raw.workers) {
    // Parse each worker with role-aware migration (handles both legacy and slot formats)
    const workers = raw.workers as Record<string, Record<string, unknown>>;
    project.workers = {};
    for (const [role, worker] of Object.entries(workers)) {
      // Migrate old role keys (dev→developer, qa→tester)
      const canonical = ROLE_ALIASES[role] ?? role;
      project.workers[canonical] = parseWorkerState(worker, role);
    }
  } else {
    project.workers = {};
  }

  // Migrate legacy `channel` (string) field to `channels` array.
  // Called with `project as any` so raw.channel may still exist on old data.
  const rawChannel = (raw.channel as string | undefined) ?? "telegram";
  if (!project.channels || project.channels.length === 0) {
    // Preserve the legacy single-channel registration. groupId is unknown here
    // (the outer loop in readProjects doesn't pass it), so we leave groupId blank
    // and callers fall back to channels[0] which still gives the right channel type.
    project.channels = [{ groupId: "", channel: rawChannel as "telegram" | "whatsapp" | "discord" | "slack", name: "primary", events: ["*"] }];
  }
  // Remove legacy field so it doesn't persist back to disk
  delete (raw as Record<string, unknown>).channel;
}
