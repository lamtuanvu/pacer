import { createHash } from "node:crypto";
import type { Terminal } from "@xterm/headless";
import { Screen } from "../../../src/session/screen";

export interface Stream { id: string; tags: string[]; data: string; chunkSizes: number[] }
export interface Corpus { schema: 1; cols: 120; rows: 40; streams: Stream[]; sha256: string }
export interface Candidate { schema: 1; engine: "vt100"; version: string; corpusSha256: string; entries: {id:string; replayBase64:string}[] }
export const corpusPath = new URL("../../../test/fixtures/sessions/vt100-synthetic.json", import.meta.url);
export async function loadCorpus(): Promise<Corpus> {
  const bytes = await Bun.file(corpusPath).bytes();
  const corpus = JSON.parse(Buffer.from(bytes).toString());
  if (corpus.schema !== 1 || corpus.cols !== 120 || corpus.rows !== 40 || !Array.isArray(corpus.streams)
    || corpus.streams.length < 20 || new Set(corpus.streams.map((s:Stream) => s.id)).size !== corpus.streams.length
    || corpus.streams.some((s:Stream) => !/^[a-z0-9-]+$/.test(s.id) || typeof s.data !== "string"
      || !Array.isArray(s.tags) || !Array.isArray(s.chunkSizes) || s.chunkSizes.some(n => !Number.isSafeInteger(n) || n < 1))) {
    throw new Error("Invalid synthetic corpus");
  }
  return {...corpus,sha256:createHash("sha256").update(bytes).digest("hex")};
}
export function chunks(stream: Stream): Uint8Array[] {
  const bytes = Buffer.from(stream.data), result: Uint8Array[] = [];
  for (let offset = 0, index = 0; offset < bytes.length; index++) {
    const end = Math.min(bytes.length, offset + (stream.chunkSizes[index % stream.chunkSizes.length] ?? bytes.length));
    result.push(bytes.subarray(offset, end)); offset = end;
  }
  return result;
}
// DECTCEM is absent from xterm's public modes object. Observe its public
// parser events before writing, returning false so xterm still handles them.
function observedScreen() {
  const screen = new Screen(120,40);
  let cursorVisible = true;
  let scrollTop = 0, scrollBottom = 39;
  for (const final of ["h", "l"]) {
    screen.term.parser.registerCsiHandler({prefix:"?",final}, params => {
      if (params.includes(25)) cursorVisible = final === "h";
      return false;
    });
  }
  screen.term.parser.registerCsiHandler({final:"r"}, params => {
    const top = Number(params[0] || 1) - 1;
    const bottom = Number(params[1] || screen.term.rows) - 1;
    if (top >= 0 && top < bottom && bottom < screen.term.rows) {
      scrollTop = top;
      scrollBottom = bottom;
    }
    return false;
  });
  screen.term.parser.registerEscHandler({final:"c"}, () => {
    cursorVisible = true;
    scrollTop = 0;
    scrollBottom = screen.term.rows - 1;
    return false;
  });
  screen.term.parser.registerCsiHandler({intermediates:"!",final:"p"}, () => {
    cursorVisible = true;
    scrollTop = 0;
    scrollBottom = screen.term.rows - 1;
    return false;
  });
  return {
    screen,
    state:() => terminalState(screen.term,cursorVisible),
    prospectiveReplay(replay:string) {
      // Experiment only. The actual Screen checkpoint above remains the gate.
      // SerializeAddon emits DECOM after its cursor restore, which homes the
      // cursor, and omits DECTCEM. Restore the observed region before DECOM/CUP.
      if (screen.term.modes.originMode) {
        const buffer = screen.term.buffer.active;
        replay += `\x1b[?6l\x1b[${scrollTop+1};${scrollBottom+1}r\x1b[?6h`;
        replay += `\x1b[${buffer.cursorY-scrollTop+1};${buffer.cursorX+1}H`;
      }
      return replay + (cursorVisible ? "\x1b[?25h" : "\x1b[?25l");
    },
  };
}
export function terminalState(term: Terminal, cursorVisible:boolean) {
  const buffer = term.buffer.active;
  const cells: unknown[][] = [];
  for (let row = 0; row < buffer.length; row++) {
    const line = buffer.getLine(row)!;
    const values: unknown[] = [line.isWrapped];
    for (let col = 0; col < term.cols; col++) {
      const cell = line.getCell(col)!;
      values.push([cell.getChars(),cell.getWidth(),cell.getFgColorMode(),cell.getFgColor(),
        cell.getBgColorMode(),cell.getBgColor(),cell.isBold(),cell.isItalic(),cell.isDim(),
        cell.isUnderline(),cell.isBlink(),cell.isInverse(),cell.isInvisible(),cell.isStrikethrough(),cell.isOverline()]);
    }
    cells.push(values);
  }
  return {cursorVisible,type:buffer.type,cursorX:buffer.cursorX,cursorY:buffer.cursorY,baseY:buffer.baseY,
    viewportY:buffer.viewportY,modes:{...term.modes},cells};
}
export async function reference(stream:Stream) {
  const {screen,state,prospectiveReplay} = observedScreen();
  try {
    for (const chunk of chunks(stream)) await screen.output(chunk);
    const replay = screen.snapshot().screenAnsi;
    return {id:stream.id,replay,prospectiveReplay:prospectiveReplay(replay),state:state()};
  } finally { screen.dispose(); }
}
export async function compareReplay(baseline:Awaited<ReturnType<typeof reference>>, replay:string) {
  const {screen,state} = observedScreen();
  try {
    await screen.output(Buffer.from(replay));
    const actual = state();
    const differences: string[] = [];
    for (const key of ["cursorVisible","type","cursorX","cursorY","baseY","viewportY","modes"] as const) {
      if (JSON.stringify(actual[key]) !== JSON.stringify(baseline.state[key])) differences.push(key);
    }
    if (JSON.stringify(actual.cells) !== JSON.stringify(baseline.state.cells)) differences.push("cells");
    const details: unknown[] = [];
    for (const key of differences.filter(key => key !== "cells")) {
      details.push({field:key,expected:baseline.state[key as keyof typeof actual],actual:actual[key as keyof typeof actual]});
    }
    if (differences.includes("cells")) {
      outer: for (let row = 0; row < Math.max(actual.cells.length,baseline.state.cells.length); row++) {
        const expected = baseline.state.cells[row], actualRow = actual.cells[row];
        if (!expected || !actualRow) { details.push({field:"row",row,expected:!!expected,actual:!!actualRow}); break; }
        for (let col = 0; col < expected.length; col++) {
          if (JSON.stringify(expected[col]) !== JSON.stringify(actualRow[col])) {
            details.push({field:col === 0 ? "wrapped" : "cell",row,col:col-1,expected:expected[col],actual:actualRow[col]});
            if (details.length >= 8) break outer;
          }
        }
      }
    }
    return {differences,details};
  } finally { screen.dispose(); }
}
export function parseCandidate(value:unknown, corpus:Corpus):Candidate {
  const candidate = value as Candidate;
  if (!candidate || candidate.schema !== 1 || candidate.engine !== "vt100" || typeof candidate.version !== "string"
    || !candidate.version || candidate.corpusSha256 !== corpus.sha256 || !Array.isArray(candidate.entries)
    || candidate.entries.length !== corpus.streams.length || new Set(candidate.entries.map(e => e.id)).size !== corpus.streams.length
    || candidate.entries.some(e => !corpus.streams.some(s => s.id === e.id) || typeof e.replayBase64 !== "string"
      || e.replayBase64.length > 16 * 1024 * 1024 || Buffer.from(e.replayBase64,"base64").toString("base64") !== e.replayBase64)) {
    throw new Error("Candidate must contain exactly one vt100 replay per stream for this corpus digest");
  }
  return candidate;
}
