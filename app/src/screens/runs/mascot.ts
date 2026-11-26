/**
 * Seeded pixel creatures for the Live board. A mascot is a pure function of the executor identity, so the same
 * executor looks the same in every session and a new executor gets a stable look with no assets. The person is
 * the only human figure: `PERSON_FIGURE` is a fixed pictogram that no seed can produce.
 */

export const MASCOT_COLUMNS = 7;
export const MASCOT_ROWS = 8;
/** Colour comes from the design system's chart tokens, picked by index (no colour values live in this file). */
export const MASCOT_TONES = 5;

export type MascotAccessory = "none" | "ears" | "horns" | "antenna";

export interface Mascot {
  /** The identity the creature was grown from. */
  seed: string;
  /** MASCOT_ROWS strings of MASCOT_COLUMNS characters; `#` is a body pixel, `.` is empty. Mirrored left to right. */
  rows: string[];
  /** Eye pixels as [column, row]; always body pixels' neighbours inside the body. */
  eyes: Array<[number, number]>;
  /** 1..MASCOT_TONES, mapped to `--chart-<n>`. */
  tone: number;
  accessory: MascotAccessory;
}

/** FNV-1a, 32 bit. */
function hash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32: a small seeded generator. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ACCESSORIES: MascotAccessory[] = ["none", "ears", "horns", "antenna"];

/** The creature for an executor identity. Same input, same pixels, always. */
export function mascotFor(identity: string): Mascot {
  const seed = identity.trim() || "unknown";
  const next = rng(hash(seed));
  const half = Math.ceil(MASCOT_COLUMNS / 2); // columns 0..3, column 3 is the mirror axis
  const grid: boolean[][] = Array.from({ length: MASCOT_ROWS }, () => Array<boolean>(MASCOT_COLUMNS).fill(false));
  // A fixed head and torso keep every creature readable; the seed grows connected fringe pixels and the feet.
  for (let r = 1; r <= 6; r++) for (let c = 2; c <= 4; c++) grid[r]![c] = true;
  for (let c = 1; c >= 0; c--) {
    for (let r = 2; r <= 6; r++) {
      if (grid[r]![c + 1] && next() < (c === 1 ? 0.6 : 0.4)) grid[r]![c] = true;
    }
  }
  // Two feet, or one in the middle when the seed gives none.
  if (next() < 0.8) grid[7]![2] = true; else grid[7]![3] = true;
  for (let r = 0; r < MASCOT_ROWS; r++) for (let c = 0; c < half - 1; c++) grid[r]![MASCOT_COLUMNS - 1 - c] = grid[r]![c]!;
  const accessory = ACCESSORIES[Math.floor(next() * ACCESSORIES.length)]!;
  if (accessory === "ears") { grid[0]![2] = true; grid[0]![4] = true; grid[1]![1] = true; grid[1]![5] = true; }
  if (accessory === "horns") { grid[0]![2] = true; grid[0]![4] = true; }
  if (accessory === "antenna") { grid[0]![3] = true; }
  const eyeRow = 3 + Math.floor(next() * 2);
  const eyes: Array<[number, number]> = [[2, eyeRow], [4, eyeRow]];
  const tone = 1 + Math.floor(next() * MASCOT_TONES);
  return {
    seed,
    rows: grid.map(row => row.map(on => (on ? "#" : ".")).join("")),
    eyes,
    tone,
    accessory,
  };
}

/**
 * The person: a head and shoulders pictogram, drawn as 7 columns by 8 rows like the creatures but with a round
 * head and no fringe, so it cannot be mistaken for one. Fixed, never seeded.
 */
export const PERSON_FIGURE: readonly string[] = [
  "..###..",
  ".#####.",
  ".#####.",
  "..###..",
  ".......",
  ".#####.",
  "#######",
  "#######",
];

/** Mark that makes the orchestrator read as the planner: a flag pole and pennant above the creature. */
export const PLANNER_FLAG: readonly string[] = [
  "###",
  "##.",
  "#..",
  "#..",
];
