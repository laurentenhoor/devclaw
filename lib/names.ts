/**
 * names.ts — Deterministic fun name generator for instances and slots.
 *
 * Uses the `unique-names-generator` package's names dictionary (~4,940 names)
 * with seed-based generation for deterministic, collision-resistant naming.
 * Names are deterministic: same seed always produces the same name.
 */

import { uniqueNamesGenerator, names as namesDictionary } from "unique-names-generator";

/** Re-export the names dictionary for testing / introspection. */
export const NAMES = namesDictionary;

/**
 * Generate a deterministic name from a seed string.
 * Same seed always returns the same name.
 * Uses the unique-names-generator library's built-in seed support
 * to avoid correlation issues with similar/comparable input seeds.
 */
export function nameFromSeed(seed: string): string {
  return uniqueNamesGenerator({
    dictionaries: [NAMES],
    seed,
  });
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
