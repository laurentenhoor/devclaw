/**
 * projects/mutations.ts — State mutations for project worker slots.
 */
import type { SlotState, RoleWorkerState, Project, ProjectsData } from "./types.js";
import { acquireLock, releaseLock, readProjects, writeProjects, resolveProjectSlug } from "./io.js";
import { emptySlot, findFreeSlot, findSlotByIssue } from "./slots.js";

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
