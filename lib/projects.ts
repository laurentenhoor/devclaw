/**
 * Atomic projects.json read/write operations.
 * All state mutations go through this module to prevent corruption.
 *
 * Uses file-level locking to prevent concurrent read-modify-write races.
 *
 * Schema: Project-first with channels array. Legacy groupId-keyed projects are
 * auto-migrated to the new schema on first read via schema-migration.ts.
 *
 * New schema:
 * {
 *   "projects": {
 *     "devclaw": {
 *       "slug": "devclaw",
 *       "repo": "~/git/devclaw",
 *       "repoRemote": "https://github.com/laurentenhoor/devclaw.git",
 *       "baseBranch": "main",
 *       "channels": [
 *         { "groupId": "-5176490302", "channel": "telegram", "name": "primary", "events": ["*"] }
 *       ],
 *       "workers": { ... }
 *     }
 *   }
 * }
 */
import fs from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { migrateProject } from "./migrations.js";
import { ensureWorkspaceMigrated, DATA_DIR } from "./setup/migrate-layout.js";
import { isLegacySchema, migrateLegacySchema } from "./schema-migration.js";


// ---------------------------------------------------------------------------
// File locking — prevents concurrent read-modify-write races
// ---------------------------------------------------------------------------

const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 10_000;

function lockPath(workspaceDir: string): string {
  return projectsPath(workspaceDir) + ".lock";
}

async function acquireLock(workspaceDir: string): Promise<void> {
  const lock = lockPath(workspaceDir);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      await fs.writeFile(lock, String(Date.now()), { flag: "wx" });
      return;
    } catch (err: any) {
      if (err.code !== "EEXIST") throw err;

      // Check for stale lock
      try {
        const content = await fs.readFile(lock, "utf-8");
        const lockTime = Number(content);
        if (Date.now() - lockTime > LOCK_STALE_MS) {
          try { await fs.unlink(lock); } catch { /* race */ }
          continue;
        }
      } catch { /* lock disappeared — retry */ }

      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }

  // Last resort: force remove potentially stale lock
  try { await fs.unlink(lockPath(workspaceDir)); } catch { /* ignore */ }
  await fs.writeFile(lock, String(Date.now()), { flag: "wx" });
}

async function releaseLock(workspaceDir: string): Promise<void> {
  try { await fs.unlink(lockPath(workspaceDir)); } catch { /* already removed */ }
}

// ---------------------------------------------------------------------------
// Per-level worker model — each level gets its own slot array
// ---------------------------------------------------------------------------

/** Slot state. Level is structural (implied by position in the levels map). */
export type SlotState = {
  active: boolean;
  issueId: string | null;
  sessionKey: string | null;
  startTime: string | null;
  previousLabel?: string | null;
  /** Deterministic fun name for this slot (e.g. "Ada", "Grace"). */
  name?: string;
};

/** Per-level worker state: levels map instead of flat slots array. */
export type RoleWorkerState = {
  levels: Record<string, SlotState[]>;
};

/**
 * Legacy WorkerState — kept for migration detection only.
 */
export type LegacyWorkerState = {
  active: boolean;
  issueId: string | null;
  startTime: string | null;
  level: string | null;
  sessions: Record<string, string | null>;
  previousLabel?: string | null;
};

/**
 * Channel registration: maps a groupId to messaging endpoint with event filters.
 */
export type Channel = {
  groupId: string;
  channel: "telegram" | "whatsapp" | "discord" | "slack";
  name: string; // e.g. "primary", "dev-chat"
  events: string[]; // e.g. ["*"] for all, ["workerComplete"] for filtered
  accountId?: string; // Optional account ID for multi-account setups
};

/**
 * Project configuration in the new project-first schema.
 */
export type Project = {
  slug: string;
  name: string;
  repo: string;
  repoRemote?: string; // Git remote URL (e.g., https://github.com/.../repo.git)
  groupName: string;
  deployUrl: string;
  baseBranch: string;
  deployBranch: string;
  /** Channels registered for this project (notification endpoints). */
  channels: Channel[];
  /** Issue tracker provider type (github or gitlab). Auto-detected at registration, stored for reuse. */
  provider?: "github" | "gitlab";
  maxDevWorkers?: number;
  maxQaWorkers?: number;
  /** Worker state per role (developer, tester, architect, or custom roles). Shared across all channels. */
  workers: Record<string, RoleWorkerState>;
};

/**
 * Legacy Project format (groupId-keyed). Used only during migration.
 */
export type LegacyProject = {
  name: string;
  repo: string;
  groupName: string;
  deployUrl: string;
  baseBranch: string;
  deployBranch: string;
  channel?: string;
  provider?: "github" | "gitlab";
  maxDevWorkers?: number;
  maxQaWorkers?: number;
  workers: Record<string, RoleWorkerState>;
};

export type ProjectsData = {
  projects: Record<string, Project>; // Keyed by slug (new schema)
};

// ---------------------------------------------------------------------------
// Slot helpers
// ---------------------------------------------------------------------------

/** Create an empty (inactive) slot. */
export function emptySlot(): SlotState {
  return {
    active: false,
    issueId: null,
    sessionKey: null,
    startTime: null,
  };
}

/** Create a blank RoleWorkerState with the given per-level capacities. */
export function emptyRoleWorkerState(levelMaxWorkers: Record<string, number>): RoleWorkerState {
  const levels: Record<string, SlotState[]> = {};
  for (const [level, max] of Object.entries(levelMaxWorkers)) {
    levels[level] = [];
    for (let i = 0; i < max; i++) {
      levels[level]!.push(emptySlot());
    }
  }
  return { levels };
}

/** Return the lowest-index inactive slot within a specific level, or null if full. */
export function findFreeSlot(roleWorker: RoleWorkerState, level: string): number | null {
  const slots = roleWorker.levels[level];
  if (!slots) return null;
  for (let i = 0; i < slots.length; i++) {
    if (!slots[i]!.active) return i;
  }
  return null;
}

/**
 * Reconcile a role's levels with the configured per-level maxWorkers.
 * - Adds missing levels, expands short arrays, shrinks idle trailing slots.
 * Active workers are never removed — they finish naturally.
 * Mutates roleWorker in place. Returns true if any changes were made.
 */
export function reconcileSlots(roleWorker: RoleWorkerState, levelMaxWorkers: Record<string, number>): boolean {
  let changed = false;
  for (const [level, max] of Object.entries(levelMaxWorkers)) {
    if (!roleWorker.levels[level]) {
      roleWorker.levels[level] = [];
    }
    const slots = roleWorker.levels[level]!;
    while (slots.length < max) {
      slots.push(emptySlot());
      changed = true;
    }
    while (slots.length > max) {
      const last = slots[slots.length - 1]!;
      if (last.active) break;
      slots.pop();
      changed = true;
    }
  }
  return changed;
}

/** Find the level and slot index for a given issueId, or null if not found. */
export function findSlotByIssue(roleWorker: RoleWorkerState, issueId: string): { level: string; slotIndex: number } | null {
  for (const [level, slots] of Object.entries(roleWorker.levels)) {
    for (let i = 0; i < slots.length; i++) {
      if (slots[i]!.issueId === issueId) return { level, slotIndex: i };
    }
  }
  return null;
}

/** Count the number of active slots across all levels. */
export function countActiveSlots(roleWorker: RoleWorkerState): number {
  let count = 0;
  for (const slots of Object.values(roleWorker.levels)) {
    for (const slot of slots) {
      if (slot.active) count++;
    }
  }
  return count;
}

function projectsPath(workspaceDir: string): string {
  return path.join(workspaceDir, DATA_DIR, "projects.json");
}

export async function readProjects(workspaceDir: string): Promise<ProjectsData> {
  await ensureWorkspaceMigrated(workspaceDir);
  const raw = await fs.readFile(projectsPath(workspaceDir), "utf-8");
  let data = JSON.parse(raw) as any;

  // Auto-migrate legacy schema to new schema
  if (isLegacySchema(data)) {
    data = await migrateLegacySchema(data);
    // Write migrated schema back to disk
    await writeProjects(workspaceDir, data as ProjectsData);
  }

  const typedData = data as ProjectsData;

  // Apply per-project migrations
  for (const project of Object.values(typedData.projects)) {
    migrateProject(project as any);
  }

  return typedData;
}

export async function writeProjects(
  workspaceDir: string,
  data: ProjectsData,
): Promise<void> {
  const filePath = projectsPath(workspaceDir);
  const tmpPath = filePath + ".tmp";
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  await fs.rename(tmpPath, filePath);
}

/**
 * Resolve a project by slug or groupId (for backward compatibility).
 * Returns the slug of the found project.
 */
export function resolveProjectSlug(
  data: ProjectsData,
  slugOrGroupId: string,
): string | undefined {
  // Direct lookup by slug
  if (data.projects[slugOrGroupId]) {
    return slugOrGroupId;
  }

  // Reverse lookup by groupId in channels
  for (const [slug, project] of Object.entries(data.projects)) {
    if (project.channels.some(ch => ch.groupId === slugOrGroupId)) {
      return slug;
    }
  }

  return undefined;
}

/**
 * Get a project by slug or groupId (dual-mode resolution).
 */
export function getProject(
  data: ProjectsData,
  slugOrGroupId: string,
): Project | undefined {
  const slug = resolveProjectSlug(data, slugOrGroupId);
  return slug ? data.projects[slug] : undefined;
}

/**
 * Get the RoleWorkerState for a given role.
 * Returns an empty state if the role has no workers configured.
 */
export function getRoleWorker(
  project: Project,
  role: string,
): RoleWorkerState {
  return project.workers[role] ?? { levels: {} };
}

/**
 * Update a specific slot in a role's worker state.
 * Uses file locking to prevent concurrent read-modify-write races.
 */
export async function updateSlot(
  workspaceDir: string,
  slugOrGroupId: string,
  role: string,
  level: string,
  slotIndex: number,
  updates: Partial<SlotState>,
): Promise<ProjectsData> {
  await acquireLock(workspaceDir);
  try {
    const data = await readProjects(workspaceDir);
    const slug = resolveProjectSlug(data, slugOrGroupId);
    if (!slug) {
      throw new Error(`Project not found for slug or groupId: ${slugOrGroupId}`);
    }

    const project = data.projects[slug]!;
    const rw = project.workers[role] ?? { levels: {} };
    if (!rw.levels[level]) rw.levels[level] = [];
    const slots = rw.levels[level]!;

    // Ensure slot exists
    while (slots.length <= slotIndex) {
      slots.push(emptySlot());
    }

    slots[slotIndex] = { ...slots[slotIndex]!, ...updates };
    project.workers[role] = rw;

    await writeProjects(workspaceDir, data);
    return data;
  } finally {
    await releaseLock(workspaceDir);
  }
}

/**
 * Mark a worker slot as active with a new task.
 * Routes by level to the correct slot array.
 * Accepts slug or groupId (dual-mode).
 */
export async function activateWorker(
  workspaceDir: string,
  slugOrGroupId: string,
  role: string,
  params: {
    issueId: string;
    level: string;
    sessionKey?: string;
    startTime?: string;
    /** Label the issue had before transitioning to the active state (e.g. "To Do", "To Improve"). */
    previousLabel?: string;
    /** Slot index within the level's array. If omitted, finds first free slot. */
    slotIndex?: number;
    /** Deterministic fun name for this slot. */
    name?: string;
  },
): Promise<ProjectsData> {
  await acquireLock(workspaceDir);
  try {
    const data = await readProjects(workspaceDir);
    const slug = resolveProjectSlug(data, slugOrGroupId);
    if (!slug) {
      throw new Error(`Project not found for slug or groupId: ${slugOrGroupId}`);
    }

    const project = data.projects[slug]!;
    const rw = project.workers[role] ?? { levels: {} };
    if (!rw.levels[params.level]) rw.levels[params.level] = [];
    const slots = rw.levels[params.level]!;

    const idx = params.slotIndex ?? findFreeSlot(rw, params.level) ?? 0;

    // Ensure slot exists
    while (slots.length <= idx) {
      slots.push(emptySlot());
    }

    slots[idx] = {
      active: true,
      issueId: params.issueId,
      sessionKey: params.sessionKey ?? slots[idx]!.sessionKey,
      startTime: params.startTime ?? new Date().toISOString(),
      previousLabel: params.previousLabel ?? null,
      name: params.name ?? slots[idx]!.name,
    };

    project.workers[role] = rw;
    await writeProjects(workspaceDir, data);
    return data;
  } finally {
    await releaseLock(workspaceDir);
  }
}

/**
 * Mark a worker slot as inactive after task completion.
 * Preserves sessionKey for session reuse.
 * Finds the slot by issueId (searches across all levels), or by explicit level+slotIndex.
 * Accepts slug or groupId (dual-mode).
 */
export async function deactivateWorker(
  workspaceDir: string,
  slugOrGroupId: string,
  role: string,
  opts?: { level?: string; slotIndex?: number; issueId?: string },
): Promise<ProjectsData> {
  await acquireLock(workspaceDir);
  try {
    const data = await readProjects(workspaceDir);
    const slug = resolveProjectSlug(data, slugOrGroupId);
    if (!slug) {
      throw new Error(`Project not found for slug or groupId: ${slugOrGroupId}`);
    }

    const project = data.projects[slug]!;
    const rw = project.workers[role] ?? { levels: {} };

    let level: string | undefined;
    let idx: number | undefined;

    if (opts?.level !== undefined && opts?.slotIndex !== undefined) {
      level = opts.level;
      idx = opts.slotIndex;
    } else if (opts?.issueId) {
      const found = findSlotByIssue(rw, opts.issueId);
      if (found) {
        level = found.level;
        idx = found.slotIndex;
      }
    }

    if (level !== undefined && idx !== undefined) {
      const slots = rw.levels[level];
      if (slots && idx < slots.length) {
        const slot = slots[idx]!;
        slots[idx] = {
          active: false,
          issueId: null,
          sessionKey: slot.sessionKey,
          startTime: null,
          previousLabel: null,
          name: slot.name,
        };
      }
    }

    project.workers[role] = rw;
    await writeProjects(workspaceDir, data);
    return data;
  } finally {
    await releaseLock(workspaceDir);
  }
}

/**
 * Resolve repo path from projects.json repo field (handles ~/ expansion).
 */
export function resolveRepoPath(repoField: string): string {
  if (repoField.startsWith("~/")) {
    return repoField.replace("~", homedir());
  }
  return repoField;
}
