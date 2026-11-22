// Candidate native-terminal driver protocol, schema 2 (replay gate).
//
// A driver is any executable that reads one JSON document on stdin and writes
// one on stdout. The harness builds the input, spawns the driver with an argv
// array (never a shell), and parses its output with `parseDriverOutput`,
// which throws on any schema, id-set, digest, base64 or size violation.

export type Engine = "vt100" | "alacritty" | "wezterm" | "vt100-layer" | "pacer-screen";
export const ENGINES: readonly Engine[] = ["vt100", "alacritty", "wezterm", "vt100-layer", "pacer-screen"];

export interface DriverInput {
  schema: 2;
  corpusSha256: string;
  scrollback: 5000;
  streams: {
    id: string;
    cols: number;
    rows: number;
    dataBase64: string;
    chunkSizes: number[];
    continuationBase64: string | null;
    resizes: { at: number; cols: number; rows: number }[];
    queries: boolean;
  }[];
  /** TS-produced screenAnsi from the oracle; the driver restores each. */
  checkpoints: { id: string; cols: number; rows: number; ansiBase64: string }[];
  widths: boolean;
}

export interface GateState {
  cursorVisible: boolean;
  type: "normal" | "alternate";
  cursorX: number;
  cursorY: number;
  baseY: number;
  viewportY: number;
  scrollTop: number;
  scrollBottom: number;
  modes: Record<string, unknown>;
  rows: [boolean, [number, string, number, number, number, number, number, number][]][];
}

export interface DriverOutput {
  schema: 2;
  engine: Engine;
  version: string;
  corpusSha256: string;
  entries: {
    id: string;
    state: GateState;
    replayBase64: string;
    repliesBase64: string[];
    plainCursor: string;
    plainViewport: string;
    selfRoundtripState: GateState;
    continuationState: GateState | null;
  }[];
  checkpoints: { id: string; state: GateState }[];
  widths: [number, number, number][] | null;
}

const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const canonicalBase64 = (value: string): boolean => Buffer.from(value, "base64").toString("base64") === value;
const decodedBytes = (value: string): number => {
  const c = value.replace(/=+$/, "").length;
  return Math.floor((c / 4) * 3) - (c % 4 === 2 ? 1 : c % 4 === 3 ? 1 : 0);
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(message);
}

function validateState(value: unknown, path: string): GateState {
  if (!isPlainObject(value)) fail(`${path}: state must be an object`);
  const state = value as GateState;
  for (const key of ["cursorVisible", "cursorX", "cursorY", "baseY", "viewportY", "scrollTop", "scrollBottom"]) {
    if (typeof state[key as keyof GateState] !== "number" && key !== "cursorVisible") fail(`${path}.${key}: expected number`);
    // cursorVisible is checked below as boolean.
  }
  if (typeof state.cursorVisible !== "boolean") fail(`${path}.cursorVisible: expected boolean`);
  if (state.type !== "normal" && state.type !== "alternate") fail(`${path}.type: expected normal|alternate`);
  if (!isPlainObject(state.modes)) fail(`${path}.modes: expected object`);
  if (!Array.isArray(state.rows)) fail(`${path}.rows: expected array`);
  for (let row = 0; row < state.rows.length; row++) {
    const entry = state.rows[row];
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "boolean" || !Array.isArray(entry[1])) {
      fail(`${path}.rows[${row}]: expected [isWrapped, runs]`);
    }
    for (const run of entry[1]) {
      if (!Array.isArray(run) || run.length !== 8
        || typeof run[0] !== "number" || typeof run[1] !== "string"
        || ![run[2], run[3], run[4], run[5], run[6], run[7]].every(n => typeof n === "number" && Number.isFinite(n))) {
        fail(`${path}.rows[${row}]: malformed run ${JSON.stringify(run)}`);
      }
    }
  }
  return state;
}

export function parseDriverOutput(value: unknown, input: DriverInput): DriverOutput {
  if (!isPlainObject(value)) fail("driver output must be an object");
  const out = value as DriverOutput;
  if (out.schema !== 2) fail(`schema must be 2, got ${out.schema}`);
  if (!ENGINES.includes(out.engine)) fail(`unknown engine ${JSON.stringify(out.engine)}`);
  if (typeof out.version !== "string" || !out.version) fail("version must be a non-empty string");
  if (out.corpusSha256 !== input.corpusSha256) fail("corpus sha256 digest does not match input");

  const expectedIds = new Set(input.streams.map(s => s.id));
  if (!Array.isArray(out.entries) || out.entries.length !== expectedIds.size) fail("entries must be exactly one per stream");
  const seen = new Set<string>();
  for (const entry of out.entries) {
    if (seen.has(entry.id)) fail(`duplicate entry id ${entry.id}`);
    seen.add(entry.id);
    if (!expectedIds.has(entry.id)) fail(`unknown entry id ${entry.id}`);
    if (typeof entry.replayBase64 !== "string") fail(`${entry.id}: replayBase64 must be a string`);
    if (!canonicalBase64(entry.replayBase64) || decodedBytes(entry.replayBase64) > MAX_ENTRY_BYTES) {
      fail(`${entry.id}: replayBase64 is not canonical base64 or exceeds 16 MiB`);
    }
    if (!Array.isArray(entry.repliesBase64)) fail(`${entry.id}: repliesBase64 must be an array`);
    for (const reply of entry.repliesBase64) {
      if (typeof reply !== "string" || !canonicalBase64(reply)) fail(`${entry.id}: non-canonical reply base64`);
    }
    if (typeof entry.plainCursor !== "string" || typeof entry.plainViewport !== "string") {
      fail(`${entry.id}: plainCursor/plainViewport must be strings`);
    }
    validateState(entry.state, `${entry.id}.state`);
    validateState(entry.selfRoundtripState, `${entry.id}.selfRoundtripState`);
    if (entry.continuationState !== null) validateState(entry.continuationState, `${entry.id}.continuationState`);
  }

  const expectedCheckpointIds = new Set(input.checkpoints.map(c => c.id));
  if (!Array.isArray(out.checkpoints) || out.checkpoints.length !== expectedCheckpointIds.size) {
    fail("checkpoints must be exactly one per oracle checkpoint");
  }
  const seenCheckpoints = new Set<string>();
  for (const cp of out.checkpoints) {
    if (seenCheckpoints.has(cp.id) || !expectedCheckpointIds.has(cp.id)) fail(`checkpoint id problem: ${cp.id}`);
    seenCheckpoints.add(cp.id);
    validateState(cp.state, `checkpoint ${cp.id}.state`);
  }

  if (input.widths) {
    if (!Array.isArray(out.widths)) fail("widths requested but absent");
    for (const row of out.widths) {
      if (!Array.isArray(row) || row.length !== 3
        || typeof row[0] !== "number" || typeof row[1] !== "number" || typeof row[2] !== "number"
        || row[0] < 0 || row[1] < row[0] || row[1] > 0x10ffff || row[2] === 1) {
        fail(`malformed width row ${JSON.stringify(row)}`);
      }
    }
  } else if (out.widths !== null) {
    fail("widths supplied but not requested");
  }

  return out;
}