/**
 * names.ts — Deterministic fun name generator for instances and slots.
 *
 * Uses the `unique-names-generator` names dictionary (~4,940 first names)
 * for a collision-resistant pool. Names are deterministic: same seed
 * always produces the same name.
 */
import { names as NAME_POOL } from "unique-names-generator";

/** Re-export for testing / introspection. */
export const NAMES: readonly string[] = NAME_POOL;

/**
 * djb2 hash — fast, deterministic string hash.
 * Returns a positive integer.
 */
function djb2(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/**
 * Generate a deterministic name from a seed string.
 * Same seed always returns the same name.
 */
export function nameFromSeed(seed: string): string {
  return NAMES[djb2(seed) % NAMES.length]!;
}

/**
 * Generate a deterministic slot name from slot coordinates.
 * e.g. slotName("myapp", "developer", "medior", 0) → "Cordelia"
 */
export function slotName(
  project: string,
  role: string,
  level: string,
  slotIndex: number,
): string {
  return nameFromSeed(`${project}-${role}-${level}-${slotIndex}`);
}
