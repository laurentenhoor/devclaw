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
 * - projects.json format: flat slots → per-level format
 */

import type { RoleWorkerState, SlotState, Project } from "./projects.js";

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
 * Legacy format has `active` at top level and no `slots` or `levels`.
 */
function isLegacyFlatFormat(worker: Record<string, unknown>): boolean {
  return "active" in worker && !("slots" in worker) && !("levels" in worker);
}

/** Detect if already in the new per-level format. */
function isLevelFormat(worker: Record<string, unknown>): boolean {
  return "levels" in worker;
}

/**
 * Parse a legacy flat worker state into per-level RoleWorkerState.
 * Extracts sessionKey from sessions[level].
 * Slots with null level are skipped (no "unknown" fallback).
 */
function parseLegacyFlatState(worker: Record<string, unknown>, role: string): RoleWorkerState {
  const level = (worker.level ?? worker.tier ?? null) as string | null;
  const migratedLevel = migrateLevel(level, role);
  const sessions = (worker.sessions as Record<string, string | null>) ?? {};
  const migratedSessions = migrateSessions(sessions, role);

  // Skip slots with no level
  if (!migratedLevel) return { levels: {} };

  // Extract sessionKey: prefer sessions[level], fall back to first non-null
  let sessionKey: string | null = null;
  if (migratedSessions[migratedLevel]) {
    sessionKey = migratedSessions[migratedLevel]!;
  } else {
    const firstNonNull = Object.values(migratedSessions).find(v => v != null);
    if (firstNonNull) sessionKey = firstNonNull;
  }

  const slot: SlotState = {
    active: worker.active as boolean,
    issueId: worker.issueId as string | null,
    sessionKey,
    startTime: worker.startTime as string | null,
    previousLabel: (worker.previousLabel as string | null) ?? null,
    name: (worker.name ?? worker.slotName) as string | undefined,
  };

  return { levels: { [migratedLevel]: [slot] } };
}

/**
 * Parse old slot-based format into per-level RoleWorkerState.
 * Groups slots by their `level` field. Slots with null level are skipped.
 */
function parseOldSlotState(worker: Record<string, unknown>, role: string): RoleWorkerState {
  const rawSlots = (worker.slots as Array<Record<string, unknown>>) ?? [];
  const levels: Record<string, SlotState[]> = {};

  for (const s of rawSlots) {
    const rawLevel = migrateLevel(s.level as string | null, role);
    if (!rawLevel) continue; // Skip null-level slots

    if (!levels[rawLevel]) levels[rawLevel] = [];
    levels[rawLevel]!.push({
      active: s.active as boolean,
      issueId: s.issueId as string | null,
      sessionKey: s.sessionKey as string | null,
      startTime: s.startTime as string | null,
      previousLabel: (s.previousLabel as string | null) ?? null,
      name: (s.name ?? s.slotName) as string | undefined,
    });
  }

  return { levels };
}

/**
 * Parse already per-level format, applying level alias migration.
 * Strips "unknown" level entries from previous migration artifacts.
 */
function parseLevelState(worker: Record<string, unknown>, role: string): RoleWorkerState {
  const rawLevels = worker.levels as Record<string, Array<Record<string, unknown>>>;
  const levels: Record<string, SlotState[]> = {};

  for (const [rawLevel, rawSlots] of Object.entries(rawLevels)) {
    // Strip "unknown" level entries (artifact from previous migration)
    if (rawLevel === "unknown") continue;

    const migratedLevel = migrateLevel(rawLevel, role) ?? rawLevel;
    if (!levels[migratedLevel]) levels[migratedLevel] = [];

    for (const s of rawSlots) {
      levels[migratedLevel]!.push({
        active: s.active as boolean,
        issueId: s.issueId as string | null,
        sessionKey: s.sessionKey as string | null,
        startTime: s.startTime as string | null,
        previousLabel: (s.previousLabel as string | null) ?? null,
        name: (s.name ?? s.slotName) as string | undefined,
      });
    }
  }

  return { levels };
}

function parseWorkerState(worker: Record<string, unknown>, role: string): RoleWorkerState {
  if (isLevelFormat(worker)) {
    return parseLevelState(worker, role);
  }
  if (isLegacyFlatFormat(worker)) {
    return parseLegacyFlatState(worker, role);
  }
  // Old slot-based format
  return parseOldSlotState(worker, role);
}

/**
 * Migrate a raw project object from old format to current format.
 *
 * Handles:
 * 1. Old format: hardcoded dev/qa/architect fields → workers map
 * 2. Old role keys in workers map (dev → developer, qa → tester)
 * 3. Old level names in worker state
 * 4. Old slot-based format → per-level format
 * 5. Missing channel field defaults to "telegram"
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
        : { levels: {} };
    }
    // Clean up old fields from the in-memory object
    delete raw.dev;
    delete raw.qa;
    delete raw.architect;
  } else if (raw.workers) {
    // Parse each worker with role-aware migration (handles all formats)
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

  // Remove roleExecution from state — now lives in workflow.yaml
  delete (raw as Record<string, unknown>).roleExecution;
}
