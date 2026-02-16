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

import type { WorkerState, Project } from "./projects.js";

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

function parseWorkerState(worker: Record<string, unknown>, role: string): WorkerState {
  const level = (worker.level ?? worker.tier ?? null) as string | null;
  const sessions = (worker.sessions as Record<string, string | null>) ?? {};
  return {
    active: worker.active as boolean,
    issueId: worker.issueId as string | null,
    startTime: worker.startTime as string | null,
    level: migrateLevel(level, role),
    sessions: migrateSessions(sessions, role),
  };
}

/** Empty worker state with null sessions for given levels. */
function emptyWorkerState(levels: string[]): WorkerState {
  const sessions: Record<string, string | null> = {};
  for (const l of levels) {
    sessions[l] = null;
  }
  return {
    active: false,
    issueId: null,
    startTime: null,
    level: null,
    sessions,
  };
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
        : emptyWorkerState([]);
    }
    // Clean up old fields from the in-memory object
    delete raw.dev;
    delete raw.qa;
    delete raw.architect;
  } else if (raw.workers) {
    // New format: parse each worker with role-aware migration
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

  if (!project.channel) {
    project.channel = "telegram";
  }
}
