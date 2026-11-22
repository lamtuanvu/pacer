import { expect, test } from "bun:test";
import { parseDriverOutput, type DriverInput } from "./protocol";
const input: DriverInput = { schema: 2, corpusSha256: "a".repeat(64), scrollback: 5000, widths: false, checkpoints: [],
  streams: [{ id: "s", cols: 4, rows: 2, dataBase64: "", chunkSizes: [1], continuationBase64: null, resizes: [], queries: false }] };
const state = { cursorVisible: true, type: "normal", cursorX: 0, cursorY: 0, baseY: 0, viewportY: 0, scrollTop: 0, scrollBottom: 1, modes: {}, rows: [] };
const ok = { schema: 2, engine: "pacer-screen", version: "0", corpusSha256: "a".repeat(64), widths: null, checkpoints: [],
  entries: [{ id: "s", state, replayBase64: "", repliesBase64: [], plainCursor: "", plainViewport: "", selfRoundtripState: state, continuationState: null }] };
test("accepts exactly one entry per stream", () => { expect(parseDriverOutput(ok, input).entries).toHaveLength(1); });
for (const [name, bad] of [
  ["unknown engine", { ...ok, engine: "other" }],
  ["wrong digest", { ...ok, corpusSha256: "b".repeat(64) }],
  ["missing entry", { ...ok, entries: [] }],
  ["duplicate entry", { ...ok, entries: [ok.entries[0], ok.entries[0]] }],
  ["non-canonical base64", { ...ok, entries: [{ ...ok.entries[0], replayBase64: "YQ" }] }],
  ["widths requested but absent", null],
] as const) test(`refuses ${name}`, () => {
  expect(() => parseDriverOutput(bad ?? ok, name === "widths requested but absent" ? { ...input, widths: true } : input)).toThrow();
});