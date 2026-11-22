import { expect, test } from "bun:test";
import { Terminal } from "@xterm/headless";
import { compareReplay, loadCorpus, reference } from "../scripts/replay-gate/replay";
import { oraclePath, OSC_10_ANSWER, OSC_11_ANSWER, extendedPath } from "../scripts/replay-gate/oracle";
import type { Oracle, ExtendedStream } from "../scripts/replay-gate/oracle";

/**
 * Production replay stays on TypeScript `Screen` until the vt100 native gate passes.
 * Session WebSocket routes must remain forwarded while native replay is NO-GO.
 */
test("TS checkpoint replay passes the synthetic vt100 corpus", async () => {
  const corpus = await loadCorpus();
  expect(corpus.streams.length).toBeGreaterThanOrEqual(20);
  const failures: { id: string; differences: string[] }[] = [];
  for (const stream of corpus.streams) {
    const baseline = await reference(stream);
    const selfCheck = await compareReplay(baseline, baseline.replay);
    if (selfCheck.differences.length) {
      failures.push({ id: stream.id, differences: selfCheck.differences });
    }
  }
  expect(failures).toEqual([]);
});

/**
 * Extended-corpus scenarios (continuation, resize, query) are checked against the
 * committed oracle as an *independent* re-derivation (not via the oracle's own
 * recorder): drive a fresh xterm, apply the stream with resizes at the recorded
 * byte offsets, then continue / query, and compare each resulting state to the
 * oracle entry. Continuation here means more output after the recorded data,
 * captured as the oracle's `continuationState`.
 */
async function exerciseExtended(stream: ExtendedStream): Promise<{
  state: ReturnType<typeof extendedState>;
  continuation?: ReturnType<typeof extendedState>;
  replies: string[];
}> {
  const term = new Terminal({ cols: 120, rows: 40, scrollback: 5000, allowProposedApi: true });
  let cursorVisible = true;
  let scrollTop = 0;
  let scrollBottom = 39;
  const replies: string[] = [];
  term.onData((reply) => replies.push(reply));
  for (const code of [10, 11] as const) {
    term.parser.registerOscHandler(code, (body) => {
      if (body !== "?") return false;
      replies.push(code === 10 ? OSC_10_ANSWER : OSC_11_ANSWER);
      return true;
    });
  }
  for (const final of ["h", "l"] as const) {
    term.parser.registerCsiHandler({ prefix: "?", final }, (params) => {
      if (params.includes(25)) cursorVisible = final === "h";
      return false;
    });
  }
  term.parser.registerCsiHandler({ final: "r" }, (params) => {
    const top = Number(params[0] || 1) - 1;
    const bottom = Number(params[1] || 40) - 1;
    if (top >= 0 && top < bottom && bottom < 40) { scrollTop = top; scrollBottom = bottom; }
    return false;
  });
  const reset = () => { cursorVisible = true; scrollTop = 0; scrollBottom = 39; return false; };
  term.parser.registerEscHandler({ final: "c" }, reset);
  term.parser.registerCsiHandler({ intermediates: "!", final: "p" }, reset);
  const cellFlags = (cell: ReturnType<NonNullable<ReturnType<Terminal["buffer"]["active"]["getLine"]>>["getCell"]> | undefined): number => {
    let f = 0;
    if (cell?.isBold()) f |= 1; if (cell?.isItalic()) f |= 2; if (cell?.isDim()) f |= 4;
    if (cell?.isUnderline()) f |= 8; if (cell?.isBlink()) f |= 16; if (cell?.isInverse()) f |= 32;
    if (cell?.isInvisible()) f |= 64; if (cell?.isStrikethrough()) f |= 128; if (cell?.isOverline()) f |= 256;
    return f;
  };
  const extendedState = () => {
    const buffer = term.buffer.active;
    const rows: unknown[] = [];
    for (let index = 0; index < buffer.length; index++) {
      const line = buffer.getLine(index);
      const runs: unknown[][] = [];
      for (let col = 0; col < term.cols; col++) {
        const cell = line?.getCell(col);
        const rec = [cell?.getChars() ?? "", cell?.getWidth() ?? 0,
          cell?.getFgColorMode() ?? 0, cell?.getFgColor() ?? 0,
          cell?.getBgColorMode() ?? 0, cell?.getBgColor() ?? 0, cellFlags(cell)];
        const last = runs[runs.length - 1];
        if (last && JSON.stringify(last.slice(1)) === JSON.stringify(rec)) last[0] = (last[0] as number) + 1;
        else runs.push([1, ...rec]);
      }
      rows.push([line?.isWrapped ?? false, runs]);
    }
    return { cursorVisible, type: buffer.type, cursorX: buffer.cursorX, cursorY: buffer.cursorY,
      baseY: buffer.baseY, viewportY: buffer.viewportY, scrollTop, scrollBottom, modes: { ...term.modes }, rows };
  };
  const writeUpTo = async (from: number, to: number) => {
    const slice = data.subarray(from, to);
    for (let i = 0, k = 0; i < slice.length; k++) {
      const size = Math.max(1, chunkSizes[k % chunkSizes.length] ?? slice.length);
      const end = Math.min(slice.length, i + size);
      await new Promise<void>((res) => term.write(slice.subarray(i, end), res));
      i = end;
    }
  };
  const data = Buffer.from(stream.data);
  const bytes = data.byteLength;
  const chunkSizes = stream.chunkSizes;
  let offset = 0;
  try {
    for (const resize of (stream.resizes ?? []).slice().sort((a, b) => a.at - b.at)) {
      const at = Math.min(Math.max(resize.at, offset), bytes);
      await writeUpTo(offset, at);
      term.resize(resize.cols, resize.rows);
      offset = at;
    }
    await writeUpTo(offset, bytes);
    const state = extendedState();
    let continuation: ReturnType<typeof extendedState> | undefined;
    const continuationData = stream.continuation;
    if (continuationData) {
      await new Promise<void>((res) => term.write(Buffer.from(continuationData), res));
      continuation = extendedState();
    }
    return { state, continuation, replies };
  } finally {
    term.dispose();
  }
}

test("extended corpus: continuation, resize and query scenario states match the oracle", async () => {
  const oracle = JSON.parse(await Bun.file(oraclePath).text()) as Oracle;
  const corpus = JSON.parse(await Bun.file(extendedPath).text()) as { streams: ExtendedStream[] };
  const failures: string[] = [];
  for (const stream of corpus.streams) {
    const entry = oracle.entries[stream.id];
    if (!entry) { failures.push(`${stream.id}: no oracle entry`); continue; }
    const result = await exerciseExtended(stream);
    const cmp = (label: string, actual: unknown, expected: unknown) => {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push(`${stream.id}: ${label} differs`);
    };
    cmp("state", result.state, entry.state);
    if (stream.continuation) {
      cmp("continuationState", result.continuation, entry.continuationState);
    } else if (entry.continuationState !== null) {
      failures.push(`${stream.id}: unexpected continuationState in oracle`);
    }
    if (stream.queries) {
      cmp("queryReplies", result.replies, (entry.queryReplies ?? []).map((r) => Buffer.from(r, "base64").toString("utf8")));
    }
  }
  expect(failures).toEqual([]);
});
