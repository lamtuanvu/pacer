import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { Screen } from "../../src/session/screen";
import { terminalState, type GateState } from "./state";
import type { Stream } from "./replay";

/** Host's fixed OSC 10/11 answers (src/session/host.ts). */
export const OSC_10_ANSWER = "\x1b]10;rgb:ffff/ffff/ffff\x1b\\";
export const OSC_11_ANSWER = "\x1b]11;rgb:0000/0000/0000\x1b\\";

export const oraclePath = new URL("../../test/fixtures/sessions/replay-oracle.json", import.meta.url);
export const widthsPath = new URL("../../test/fixtures/sessions/xterm-unicode-v6-widths.json", import.meta.url);
const syntheticPath = new URL("../../test/fixtures/sessions/vt100-synthetic.json", import.meta.url);
export const extendedPath = new URL("../../test/fixtures/sessions/replay-extended.json", import.meta.url);

export interface ResizeSpec { at: number; cols: number; rows: number }
/** A stream as the oracle recorder needs it; fuzz streams satisfy this shape. */
export interface RecordableStream {
  id: string;
  data: string;
  chunkSizes: number[];
  continuation?: string;
  resizes?: ResizeSpec[];
  queries?: boolean;
}
export interface ExtendedStream extends Stream {
  continuation?: string;
  resizes?: ResizeSpec[];
  queries?: boolean;
}
export interface CorpusFile {
  schema: 1;
  cols: 120;
  rows: 40;
  streams: ExtendedStream[];
}

export interface OracleEntry {
  cols: number;
  rows: number;
  /** xterm source GateState after writing data and applying all resizes. */
  state: GateState;
  /** Screen.snapshot().screenAnsi, base64 (TS-written checkpoint for H4). */
  screenAnsi: string;
  /** state after writing the continuation (null when none). */
  continuationState: GateState | null;
  /** state after each resize, in order. */
  resizeStates: { at: number; cols: number; rows: number; state: GateState }[];
  /** xterm onData replies plus the host's fixed OSC 10/11 answers, base64. */
  queryReplies: string[];
  plainCursor: string;
  plainViewport: string;
}
export interface Oracle {
  schema: 2;
  cols: number;
  rows: number;
  scrollback: number;
  corpora: string[];
  entries: Record<string, OracleEntry>;
}

async function loadCorpusFile(path: URL): Promise<CorpusFile> {
  const bytes = await Bun.file(path).bytes();
  const corpus = JSON.parse(Buffer.from(bytes).toString()) as CorpusFile;
  if (corpus.schema !== 1 || corpus.cols !== 120 || corpus.rows !== 40 || !Array.isArray(corpus.streams)
    || corpus.streams.length < 1
    || corpus.streams.some((s) => !/^[a-z0-9-]+$/.test(s.id) || typeof s.data !== "string"
      || !Array.isArray(s.tags) || !Array.isArray(s.chunkSizes) || s.chunkSizes.some((n) => !Number.isSafeInteger(n) || n < 1)
      || (s.continuation !== undefined && typeof s.continuation !== "string")
      || (s.resizes !== undefined && (!Array.isArray(s.resizes) || s.resizes.some((r) =>
        !Number.isInteger(r.at) || !Number.isInteger(r.cols) || !Number.isInteger(r.rows)
        || r.cols < 1 || r.rows < 1)))
      || (s.queries !== undefined && typeof s.queries !== "boolean"))) {
    throw new Error("Invalid corpus file " + path);
  }
  return corpus;
}

const b64 = (s: string) => Buffer.from(s).toString("base64");

/**
 * Record oracle entries for arbitrary streams (used for the runtime fuzz oracle
 * in addition to the committed synthetic + extended corpora recorded in
 * `buildOracle`).
 */
export async function recordStreams(streams: RecordableStream[]): Promise<Record<string, OracleEntry>> {
  const entries: Record<string, OracleEntry> = {};
  for (const stream of streams) entries[stream.id] = await recordStream(stream);
  return entries;
}

/**
 * Lightweight oracle for differential fuzz (H10): only the final source state
 * and plain text are needed, so the expensive screenAnsi / resize / query side
 * data is skipped. Replay (not capture) dominates the cost.
 */
export async function recordStates(
  streams: RecordableStream[],
): Promise<Record<string, { state: GateState; plainCursor: string; plainViewport: string }>> {
  const out: Record<string, { state: GateState; plainCursor: string; plainViewport: string }> = {};
  for (const stream of streams) {
    const screen = new Screen();
    let cursorVisible = true;
    let scrollTop = 0;
    let scrollBottom = screen.term.rows - 1;
    for (const final of ["h", "l"] as const) {
      screen.term.parser.registerCsiHandler({ prefix: "?", final }, (params) => {
        if (params.includes(25)) cursorVisible = final === "h";
        return false;
      });
    }
    screen.term.parser.registerCsiHandler({ final: "r" }, (params) => {
      const top = Number(params[0] || 1) - 1;
      const bottom = Number(params[1] || screen.term.rows) - 1;
      if (top >= 0 && top < bottom && bottom < screen.term.rows) { scrollTop = top; scrollBottom = bottom; }
      return false;
    });
    try {
      const data = Buffer.from(stream.data);
      for (let i = 0, k = 0; i < data.byteLength; k++) {
        const size = Math.max(1, stream.chunkSizes[k % stream.chunkSizes.length] ?? data.byteLength);
        const end = Math.min(data.byteLength, i + size);
        await screen.output(data.subarray(i, end));
        i = end;
      }
      out[stream.id] = {
        state: terminalState(screen.term, cursorVisible, scrollTop, scrollBottom),
        plainCursor: screen.plain(false),
        plainViewport: screen.plain(true),
      };
    } finally {
      screen.dispose();
    }
  }
  return out;
}

/** Build one oracle entry for a stream by replaying it through a live Screen. */
async function recordStream(stream: RecordableStream): Promise<OracleEntry> {
  const screen = new Screen();
  const replies: string[] = [];
  screen.term.onData((reply) => replies.push(reply));
  for (const code of [10, 11] as const) {
    screen.term.parser.registerOscHandler(code, (body) => {
      if (body !== "?") return false;
      replies.push(code === 10 ? OSC_10_ANSWER : OSC_11_ANSWER);
      return true;
    });
  }
  let cursorVisible = true;
  let scrollTop = 0;
  let scrollBottom = screen.term.rows - 1;
  const observe = () => {
    for (const final of ["h", "l"] as const) {
      screen.term.parser.registerCsiHandler({ prefix: "?", final }, (params) => {
        if (params.includes(25)) cursorVisible = final === "h";
        return false;
      });
    }
    screen.term.parser.registerCsiHandler({ final: "r" }, (params) => {
      const top = Number(params[0] || 1) - 1;
      const bottom = Number(params[1] || screen.term.rows) - 1;
      if (top >= 0 && top < bottom && bottom < screen.term.rows) { scrollTop = top; scrollBottom = bottom; }
      return false;
    });
    const reset = () => { cursorVisible = true; scrollTop = 0; scrollBottom = screen.term.rows - 1; return false; };
    screen.term.parser.registerEscHandler({ final: "c" }, reset);
    screen.term.parser.registerCsiHandler({ intermediates: "!", final: "p" }, reset);
  };
  observe();
  const state = () => terminalState(screen.term, cursorVisible, scrollTop, scrollBottom);

  const data = Buffer.from(stream.data);
  const bytes = data.byteLength;
  const resizeStates: OracleEntry["resizeStates"] = [];
  const resizes = (stream.resizes ?? []).slice().sort((a, b) => a.at - b.at);
  let offset = 0;
  for (const resize of resizes) {
    const at = Math.min(Math.max(resize.at, offset), bytes);
    await writeUpTo(screen, data, offset, at, stream.chunkSizes);
    screen.resize(resize.cols, resize.rows);
    resizeStates.push({ ...resize, state: state() });
    offset = at;
  }
  await writeUpTo(screen, data, offset, bytes, stream.chunkSizes);

  const screenAnsi = screen.snapshot().screenAnsi;
  const stateAfterData = state();
  // Plain text reflects the source stream's end state (before any continuation),
  // so capture it here to match `state` and H11's comparison baseline.
  const plainCursor = screen.plain(false);
  const plainViewport = screen.plain(true);
  let continuationState: GateState | null = null;
  if (stream.continuation) {
    await screen.output(Buffer.from(stream.continuation));
    continuationState = state();
  }
  const entry: OracleEntry = {
    cols: screen.term.cols,
    rows: screen.term.rows,
    state: stateAfterData,
    screenAnsi: b64(screenAnsi),
    continuationState,
    resizeStates,
    queryReplies: stream.queries === true ? replies.map(b64) : [],
    plainCursor,
    plainViewport,
  };
  screen.dispose();
  return entry;
}

async function writeUpTo(screen: Screen, data: Uint8Array, from: number, to: number, chunkSizes: number[]): Promise<void> {
  const slice = data.subarray(from, to);
  for (let i = 0, k = 0; i < slice.byteLength; k++) {
    const size = Math.max(1, chunkSizes[k % chunkSizes.length] ?? slice.byteLength);
    const end = Math.min(slice.byteLength, i + size);
    await screen.output(slice.subarray(i, end));
    i = end;
  }
}

/**
 * Ranges of Unicode scalars whose xterm width is not 1 (excluding surrogates).
 *
 * Measurement is batched: one terminal with enough rows, each codepoint stamped
 * onto its own row via CUP (`\x1b[<row>;1H`), a chunk written in a single
 * buffer and awaited (Terminal.write is async), then each row's leading cell
 * width read back. Without batching, per-char awaited writes over the full
 * scalar range take tens of seconds.
 */
export async function computeWidthTable(): Promise<[number, number, number][]> {
  const rows = 512; // codepoints stamped per chunk
  const term = new HeadlessTerminal({ cols: 4, rows, scrollback: 0, allowProposedApi: true });
  const ranges: [number, number, number][] = [];
  let start = -1, end = -1, width = 0;
  const flush = () => { if (start !== -1) { ranges.push([start, end, width]); start = -1; end = -1; width = 0; } };
  const record = (cp: number, w: number) => {
    if (w !== 1) {
      if (start === -1 || width !== w || cp !== end + 1) { flush(); start = cp; width = w; }
      end = cp;
    } else {
      flush();
    }
  };
  try {
    let pending: number[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue; // surrogates
      // Control and zero-width-space characters are reported narrow.
      if (cp < 0x20 || cp === 0x7f || cp === 0x85 || cp === 0x200b) { flush(); continue; }
      pending.push(cp);
      if (pending.length === rows) {
        await writeChunkAndRead(term, pending, record);
        pending = [];
      }
    }
    if (pending.length > 0) await writeChunkAndRead(term, pending, record);
  } finally {
    term.dispose();
  }
  return ranges;
}

/** Stamp `cps` onto distinct rows, write once, await it, then read widths. */
async function writeChunkAndRead(
  term: HeadlessTerminal,
  cps: number[],
  record: (cp: number, w: number) => void,
): Promise<void> {
  let chunk = "";
  for (let r = 0; r < cps.length; r++) {
    chunk += `\x1b[${r + 1};1H${String.fromCodePoint(cps[r])}`;
  }
  // Pass a completion callback: `write()` without one resolves before the input
  // has been parsed, leaving the buffer un-populated.
  await new Promise<void>((resolve) => term.write(Buffer.from(chunk, "utf8"), resolve));
  for (let r = 0; r < cps.length; r++) {
    const cell = term.buffer.active.getLine(r)?.getCell(0);
    record(cps[r], cell?.getWidth() ?? 1);
  }
}

export async function buildOracle(): Promise<{ oracle: Oracle; widths: [number, number, number][] }> {
  const [synthetic, extended] = await Promise.all([loadCorpusFile(syntheticPath), loadCorpusFile(extendedPath)]);
  const entries: Record<string, OracleEntry> = {};
  for (const stream of [...synthetic.streams, ...extended.streams]) {
    entries[stream.id] = await recordStream(stream);
  }
  const oracle: Oracle = {
    schema: 2,
    cols: 120,
    rows: 40,
    scrollback: 5000,
    corpora: [
      createHash("sha256").update(await Bun.file(syntheticPath).bytes()).digest("hex"),
      createHash("sha256").update(await Bun.file(extendedPath).bytes()).digest("hex"),
    ],
    entries,
  };
  const widths = await computeWidthTable();
  return { oracle, widths };
}

async function main() {
  const args = process.argv.slice(2);
  const { oracle, widths } = await buildOracle();
  const payload = (data: unknown) => JSON.stringify(data, null, 2) + "\n";
  const oracleText = payload(oracle);
  const widthsText = payload(widths);
  if (args.includes("--write")) {
    await writeFile(oraclePath, oracleText);
    await writeFile(widthsPath, widthsText);
    console.log(`wrote oracle (${oracleText.length} B) and width table (${widthsText.length} B)`);
    return;
  }
  if (args.includes("--check")) {
    const currentOracle = await Bun.file(oraclePath).text();
    const currentWidths = await Bun.file(widthsPath).text();
    if (currentOracle !== oracleText || currentWidths !== widthsText) {
      console.error("oracle is stale; run bun scripts/replay-gate/oracle.ts --write");
      process.exit(1);
    }
    console.log("oracle and width table are current");
    return;
  }
  console.error("usage: oracle.ts --write | --check");
  process.exit(2);
}

if (import.meta.main) {
  await main();
}