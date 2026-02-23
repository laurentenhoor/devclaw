/**
 * names.ts — Deterministic fun name generator for instances and slots.
 *
 * Uses a curated list of distinct, easy-to-distinguish names.
 * Names are deterministic: same seed always produces the same name.
 */

/**
 * Curated name pool with visually and phonetically distinct names.
 * Selected for diversity across:
 * - Starting letters (good distribution across alphabet)
 * - Syllable patterns (different rhythms and sounds)
 * - Visual distinctiveness (easy to tell apart at a glance)
 * - Length variety (mix of short, medium, and longer names)
 * 
 * Avoids similar-looking pairs like Selena/Selestina, Anna/Anne, etc.
 */
export const NAMES: readonly string[] = [
  // A-D
  "Alex", "Aria", "Atlas", "Aurora", "Blake", "Brooks", "Cameron", "Charlie",
  "Dakota", "Delta", "Dylan",
  // E-H
  "Echo", "Eden", "Ellis", "Felix", "Finn", "Griffin", "Harper", "Hunter",
  // I-L
  "Indigo", "Iris", "Jordan", "Jules", "Kai", "Kennedy", "Logan", "Luna",
  // M-P
  "Maple", "Mars", "Morgan", "Nova", "Onyx", "Parker", "Phoenix", "Piper",
  // Q-T
  "Quinn", "Rain", "River", "Robin", "Rowan", "Sage", "Skylar", "Sterling",
  "Taylor", "Tessa", "Theo",
  // U-Z
  "Uma", "Vesper", "Violet", "Wade", "Willow", "Winter", "Zane", "Zara",
  // Additional diverse names
  "Archer", "Aspen", "Bailey", "Briar", "Cedar", "Clover", "Cove", "Cypress",
  "Ember", "Fern", "Flora", "Hayes", "Hazel", "Jasper", "Juniper", "Kit",
  "Lake", "Lennox", "Marlowe", "Meadow", "Nico", "Ocean", "Orion", "Peyton",
  "Raven", "Reed", "Reese", "Remy", "Ridge", "Scout", "Sienna", "Sloane",
  "Storm", "Sutton", "Vale", "Wren", "Wynter",
];

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
