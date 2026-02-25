/**
 * projects/slots.ts — Pure slot helpers (no I/O).
 */
import type { SlotState, RoleWorkerState } from "./types.js";

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
