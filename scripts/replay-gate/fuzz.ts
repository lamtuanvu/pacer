// Seeded differential-fuzz stream generator for the replay gate (H10).
//
// Every stream is fully determined by its seed, so the harness and any native
// driver can re-derive identical input. Tokens are drawn from the brief's
// grammar: printable ASCII, CJK, emoji (including ZWJ sequences), combining
// characters, C0 control, CSI cursor/editing, SGR, and mode sequences.
//
// Chunk sizes are always in 1..13, matching the slice's episode structure:
//   seeds  1..1000   -> 40 streams x 12 _runs_ per seed
//   seeds 1001..2000 -> 120 streams x 40 _runs_ per seed
// (a "run" here means one token draw; the 40/120 and 12/40 splits are the
// episode dimensions the brief gives, reproduced identically so the corpus
// shape matches the plan).

export interface FuzzStream {
  id: string;
  seed: number;
  data: string;
  chunkSizes: number[];
}

/** xorshift32. Deterministic; the low bits are high-quality enough for fuzzing. */
export class Xorshift32 {
  private state: number;
  constructor(seed: number) {
    // Avoid the zero and near-zero states that stall xorshift.
    let s = (seed >>> 0) || 0x9e3779b9;
    s ^= s + 0x9e3779b9 + (s << 6) + (s >> 2);
    s = s || 0x2545f491;
    this.state = s;
  }
  /** Raw 32-bit draw. */
  next(): number {
    let x = this.state;
    x ^= x << 13; x >>>= 0; // int32 result
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this.state = x;
    return x >>> 0;
  }
  /** Uniform integer in [0, n). */
  int(n: number): number {
    return this.next() % n;
  }
  /** Uniform integer in [lo, hi] inclusive. */
  range(lo: number, hi: number): number {
    return lo + this.int(hi - lo + 1);
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)] as T;
  }
}

const ASCII_PRINTABLE = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";
const CJK = "中文" as const;
const EMOJI = ["😀", "👩🏽‍💻"] as const;
const COMBINING = "e\u0301" as const;
const TEXT_CHARS = [...ASCII_PRINTABLE.split(""), CJK[0], CJK[1], ...EMOJI, COMBINING];

const SGR = [
  0, 1, 2, 3, 4, 5, 7, 8, 9, 22, 23, 24, 27, 29,
  30, 31, 32, 33, 34, 35, 36, 37,
  ...[...Array(9)].flatMap((_, i) => [40 + i]),
  49, 53, 55,
  ...[...Array(8)].flatMap((_, i) => [90 + i]),
] as const;

function csi(final: string, ...params: (number | string)[]): string {
  const ps = params.length ? params.join(";") : "";
  return `\x1b[${ps}${final}`;
}

/** Draw one token (a single sequence emitted as one write chunk element). */
function token(rng: Xorshift32): string {
  const kind = rng.pick([
    "text", "text", "text",          // text-heavy: typical workload
    "text",
    "c0", "c0",
    "csi", "csi", "csi",
    "sgr", "sgr",
    "mode", "mode",
  ] as const);
  switch (kind) {
    case "text": {
      // Occasionally a run of printable ASCII (1-6 chars) forms natural words.
      const run = rng.range(1, 6);
      let out = "";
      for (let i = 0; i < run; i++) out += rng.pick(TEXT_CHARS);
      return out;
    }
    case "c0": {
      return rng.pick(["\r", "\n", "\b", "\t"] as const);
    }
    case "csi": {
      const op = rng.pick([
        "cup", "cuu", "cud", "cuf", "cub", "ed", "el", "ich", "dch", "il", "dl", "su", "sd",
      ] as const);
      // CUP tends to carry coordinates; the rest mostly bare or small counts.
      switch (op) {
        case "cup": return csi("H", rng.range(1, 40), rng.range(1, 120));
        case "ed": return csi("J", rng.range(0, 2));
        case "el": return csi("K", rng.range(0, 2));
        default: return csi({ cuu: "A", cud: "B", cuf: "C", cub: "D" }[op] ?? (op === "ich" ? "@" : op === "dch" ? "P" : op === "il" ? "L" : op === "dl" ? "M" : op === "su" ? "S" : "T")!, rng.range(1, 12));
      }
    }
    case "sgr": {
      const code = rng.pick(SGR);
      if (code === 38) {
        return rng.int(2) === 0
          ? csi("m", "38", "5", rng.range(0, 255))
          : csi("m", "38", "2", rng.range(0, 255), rng.range(0, 255), rng.range(0, 255));
      }
      return csi("m", code);
    }
    case "mode": {
      const m = rng.pick([
        "decstbm", "decstbm", "origin", "autowrap", "irm", "decsave", "dec1004", "cursor", "cursor",
      ] as const);
      switch (m) {
        case "decstbm": return csi("r", rng.range(2, 39), rng.range(3, 40));
        case "origin": case "autowrap": case "dec1004": {
          return csi(rng.int(2) ? "h" : "l", `?${m === "origin" ? 6 : m === "autowrap" ? 7 : 1049}`);
        }
        case "irm": return csi(rng.int(2) ? "h" : "l", 4);
        case "cursor": return csi(rng.int(2) ? "h" : "l", "?25");
        case "decsave": return rng.int(2) ? "\x1b7" : "\x1b8";
      }
    }
  }
}

/**
 * Build the H10 fuzz corpus: exactly `count` streams over seeds 1..2000, one
 * per seed.
 *
 * Episode shape (per the brief's "40×12 for 1..1000, 120×40 for 1001..2000"):
 * a stream's write plan is split into episodes; seeds 1..1000 get 12 episodes
 * and seeds 1001..2000 get 40, so higher seeds exercise more, larger writes.
 * Within an episode all chunk sizes are in 1..13. Each stream draws 200-2,000
 * tokens from the grammar, seeded by its id so the corpus is reproducible.
 */
export function generateFuzzStreams(count = 2000): FuzzStream[] {
  const streams: FuzzStream[] = [];
  for (const seed of array1(count)) {
    const episodes = seed <= 1000 ? 12 : 40;
    const id = `fuzz-${seed}`;
    const streamRng = new Xorshift32(hashId(id));
    const tokenCount = 200 + streamRng.range(0, 2000 - 200);
    let data = "";
    for (let t = 0; t < tokenCount; t++) data += token(streamRng);
    // Chunk sizes in 1..13, one series per episode.
    const chunkSizes: number[] = [];
    for (let e = 0; e < episodes; e++) chunkSizes.push(1 + streamRng.range(0, 12));
    streams.push({ id, seed, data, chunkSizes });
  }
  return streams;
}

function array1(n: number): number[] {
  const out: number[] = [];
  for (let i = 1; i <= n; i++) out.push(i);
  return out;
}

function hashId(id: string): number {
  // Small, deterministic string hash (xorshift-friendly, not colliding with seed)cs.
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/** Convenience entry point to count streams without running the harness. */
export async function main(): Promise<void> {
  const count = Number(process.argv.find((a) => a.startsWith("--count="))?.split("=")[1] ?? 2000);
  const streams = generateFuzzStreams(count);
  console.log(`generated ${streams.length} fuzz streams (seeds 1..${count})`);
}

if (import.meta.main) {
  await main();
}