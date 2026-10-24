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
export function terminalState(term: Terminal) {
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
  return {type:buffer.type,cursorX:buffer.cursorX,cursorY:buffer.cursorY,baseY:buffer.baseY,
    viewportY:buffer.viewportY,modes:{...term.modes},cells};
}
export async function reference(stream:Stream) {
  const screen = new Screen(120,40);
  try {
    for (const chunk of chunks(stream)) await screen.output(chunk);
    return {id:stream.id,replay:screen.snapshot().screenAnsi,state:terminalState(screen.term)};
  } finally { screen.dispose(); }
}
export async function compareReplay(baseline:Awaited<ReturnType<typeof reference>>, replay:string) {
  const screen = new Screen(120,40);
  try {
    await screen.output(Buffer.from(replay));
    const state = terminalState(screen.term);
    const differences: string[] = [];
    for (const key of ["type","cursorX","cursorY","baseY","viewportY","modes"] as const) {
      if (JSON.stringify(state[key]) !== JSON.stringify(baseline.state[key])) differences.push(key);
    }
    if (JSON.stringify(state.cells) !== JSON.stringify(baseline.state.cells)) differences.push("cells");
    const details: unknown[] = [];
    for (const key of differences.filter(key => key !== "cells")) {
      details.push({field:key,expected:baseline.state[key as keyof typeof state],actual:state[key as keyof typeof state]});
    }
    if (differences.includes("cells")) {
      outer: for (let row = 0; row < Math.max(state.cells.length,baseline.state.cells.length); row++) {
        const expected = baseline.state.cells[row], actual = state.cells[row];
        if (!expected || !actual) { details.push({field:"row",row,expected:!!expected,actual:!!actual}); break; }
        for (let col = 0; col < expected.length; col++) {
          if (JSON.stringify(expected[col]) !== JSON.stringify(actual[col])) {
            details.push({field:col === 0 ? "wrapped" : "cell",row,col:col-1,expected:expected[col],actual:actual[col]});
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
