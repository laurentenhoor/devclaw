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
import type { ExecutionMode } from "./workflow.js";

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
// Slot-based worker model — supports multiple concurrent workers per role
// ---------------------------------------------------------------------------

export type SlotState = {
  active: boolean;
  issueId: string | null;
  level: string | null;
  sessionKey: string | null;
  startTime: string | null;
  previousLabel?: string | null;
};

export type RoleWorkerState = {
  maxWorkers: number;
  slots: SlotState[];
};

/**
 * Legacy WorkerState — kept for migration detection and backward compatibility.
 * All new code should use RoleWorkerState / SlotState.
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
 * @deprecated Use RoleWorkerState. Kept as alias for consumers not yet migrated.
 * Maps to slot[0] of a RoleWorkerState for single-worker backward compatibility.
 */
export type WorkerState = LegacyWorkerState;

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
  /** Project-level role execution: parallel (DEVELOPER+TESTER can run simultaneously) or sequential (only one role at a time). Default: parallel */
  roleExecution?: ExecutionMode;
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
  roleExecution?: ExecutionMode;
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
    level: null,
    sessionKey: null,
    startTime: null,
  };
}

/** Create a blank RoleWorkerState with the given number of slots. */
export function emptyRoleWorkerState(maxWorkers: number = 1): RoleWorkerState {
  const slots: SlotState[] = [];
  for (let i = 0; i < maxWorkers; i++) {
    slots.push(emptySlot());
  }
  return { maxWorkers, slots };
}

/** Return the lowest-index inactive slot, or null if all slots are active. */
export function findFreeSlot(roleWorker: RoleWorkerState): number | null {
  for (let i = 0; i < roleWorker.slots.length; i++) {
    if (!roleWorker.slots[i]!.active) return i;
  }
  return null;
}

/** Find the slot index for a given issueId, or null if not found. */
export function findSlotByIssue(roleWorker: RoleWorkerState, issueId: string): number | null {
  for (let i = 0; i < roleWorker.slots.length; i++) {
    if (roleWorker.slots[i]!.issueId === issueId) return i;
  }
  return null;
}

/** Count the number of active slots. */
export function countActiveSlots(roleWorker: RoleWorkerState): number {
  return roleWorker.slots.filter(s => s.active).length;
}

// ---------------------------------------------------------------------------
// Backward-compatible helpers (bridge old single-worker callers)
// ---------------------------------------------------------------------------

/**
 * @deprecated Use emptyRoleWorkerState(). Kept for callers not yet migrated.
 * Creates a RoleWorkerState with 1 slot (single-worker compat).
 */
export function emptyWorkerState(_levels?: string[]): RoleWorkerState {
  return emptyRoleWorkerState(1);
}

/**
 * Get session key for a specific level from slot 0 of a role's worker state.
 * @deprecated Prefer direct slot access via roleWorker.slots[i].sessionKey
 */
export function getSessionForLevel(
  worker: RoleWorkerState | LegacyWorkerState,
  level: string,
): string | null {
  // New slot-based format
  if ("slots" in worker) {
    // Find a slot with matching level that has a sessionKey
    for (const slot of worker.slots) {
      if (slot.level === level && slot.sessionKey) return slot.sessionKey;
    }
    return null;
  }
  // Legacy format fallback
  return (worker as LegacyWorkerState).sessions[level] ?? null;
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
 * Returns a single-slot empty state if the role has no workers configured.
 */
export function getRoleWorker(
  project: Project,
  role: string,
): RoleWorkerState {
  return project.workers[role] ?? emptyRoleWorkerState(1);
}

/** Convert a slot to a LegacyWorkerState for backward compatibility. */
function slotToLegacy(rw: RoleWorkerState, slotIndex: number): LegacyWorkerState {
  const slot = rw.slots[slotIndex] ?? emptySlot();
  const sessions: Record<string, string | null> = {};
  if (slot.level && slot.sessionKey) {
    sessions[slot.level] = slot.sessionKey;
  }
  return {
    active: slot.active,
    issueId: slot.issueId,
    startTime: slot.startTime,
    level: slot.level,
    sessions,
    previousLabel: slot.previousLabel,
  };
}

/**
 * Get a backward-compatible single-worker view (slot 0) for callers not yet migrated.
 * @deprecated Use getRoleWorker() + slot-based access. Will be removed after #328-#331.
 */
export function getWorker(
  project: Project,
  role: string,
): LegacyWorkerState {
  const rw = getRoleWorker(project, role);
  return slotToLegacy(rw, 0);
}

/**
 * Update a specific slot in a role's worker state.
 * Uses file locking to prevent concurrent read-modify-write races.
 */
export async function updateSlot(
  workspaceDir: string,
  slugOrGroupId: string,
  role: string,
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
    const rw = project.workers[role] ?? emptyRoleWorkerState(1);
    
    // Ensure slot exists (expand slots array if needed)
    while (rw.slots.length <= slotIndex) {
      rw.slots.push(emptySlot());
    }

    rw.slots[slotIndex] = { ...rw.slots[slotIndex]!, ...updates };
    project.workers[role] = rw;

    await writeProjects(workspaceDir, data);
    return data;
  } finally {
    await releaseLock(workspaceDir);
  }
}

/**
 * Update worker state for a project (backward-compatible single-slot mode).
 * Operates on slot 0. Callers should migrate to updateSlot() for multi-slot support.
 * @deprecated Use updateSlot() for explicit slot control.
 */
export async function updateWorker(
  workspaceDir: string,
  slugOrGroupId: string,
  role: string,
  updates: Partial<LegacyWorkerState>,
): Promise<ProjectsData> {
  await acquireLock(workspaceDir);
  try {
    const data = await readProjects(workspaceDir);
    const slug = resolveProjectSlug(data, slugOrGroupId);
    if (!slug) {
      throw new Error(`Project not found for slug or groupId: ${slugOrGroupId}`);
    }

    const project = data.projects[slug]!;
    const rw = project.workers[role] ?? emptyRoleWorkerState(1);
    
    // Operate on slot 0 for backward compatibility
    const slot = rw.slots[0] ?? emptySlot();
    
    if (updates.active !== undefined) slot.active = updates.active;
    if (updates.issueId !== undefined) slot.issueId = updates.issueId;
    if (updates.level !== undefined) slot.level = updates.level;
    if (updates.startTime !== undefined) slot.startTime = updates.startTime;
    if (updates.previousLabel !== undefined) slot.previousLabel = updates.previousLabel;
    
    // Map sessions to sessionKey on slot 0
    if (updates.sessions) {
      // Find the session key for the current level, or take the first non-null
      const level = updates.level ?? slot.level;
      if (level && updates.sessions[level] !== undefined) {
        slot.sessionKey = updates.sessions[level];
      } else {
        // Set to first non-null session, or null to clear
        const firstEntry = Object.entries(updates.sessions).find(([, v]) => v != null);
        if (firstEntry) {
          slot.sessionKey = firstEntry[1];
        } else if (Object.values(updates.sessions).every(v => v === null)) {
          slot.sessionKey = null;
        }
      }
    }
    
    rw.slots[0] = slot;
    project.workers[role] = rw;

    await writeProjects(workspaceDir, data);
    return data;
  } finally {
    await releaseLock(workspaceDir);
  }
}

/**
 * Mark a worker slot as active with a new task.
 * When slotIndex is provided, activates that specific slot.
 * Otherwise, finds the first free slot (backward compatible with single-slot callers).
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
    /** Slot index to activate. If omitted, finds first free slot (defaults to 0). */
    slotIndex?: number;
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
    const rw = project.workers[role] ?? emptyRoleWorkerState(1);
    
    const idx = params.slotIndex ?? findFreeSlot(rw) ?? 0;
    
    // Ensure slot exists
    while (rw.slots.length <= idx) {
      rw.slots.push(emptySlot());
    }
    
    rw.slots[idx] = {
      active: true,
      issueId: params.issueId,
      level: params.level,
      sessionKey: params.sessionKey ?? rw.slots[idx]!.sessionKey,
      startTime: params.startTime ?? new Date().toISOString(),
      previousLabel: params.previousLabel ?? null,
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
 * Preserves sessionKey and level for session reuse.
 * When issueId is provided, finds the slot with that issue.
 * When slotIndex is provided, deactivates that specific slot.
 * Otherwise deactivates slot 0 (backward compatible).
 * Accepts slug or groupId (dual-mode).
 */
export async function deactivateWorker(
  workspaceDir: string,
  slugOrGroupId: string,
  role: string,
  opts?: { slotIndex?: number; issueId?: string },
): Promise<ProjectsData> {
  await acquireLock(workspaceDir);
  try {
    const data = await readProjects(workspaceDir);
    const slug = resolveProjectSlug(data, slugOrGroupId);
    if (!slug) {
      throw new Error(`Project not found for slug or groupId: ${slugOrGroupId}`);
    }

    const project = data.projects[slug]!;
    const rw = project.workers[role] ?? emptyRoleWorkerState(1);
    
    let idx: number;
    if (opts?.slotIndex !== undefined) {
      idx = opts.slotIndex;
    } else if (opts?.issueId) {
      idx = findSlotByIssue(rw, opts.issueId) ?? 0;
    } else {
      // Backward compat: deactivate slot 0
      idx = 0;
    }
    
    if (idx < rw.slots.length) {
      const slot = rw.slots[idx]!;
      // Preserve sessionKey and level for reuse
      rw.slots[idx] = {
        active: false,
        issueId: null,
        level: slot.level,
        sessionKey: slot.sessionKey,
        startTime: null,
        previousLabel: null,
      };
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
