import { describe, expect, test } from "bun:test";
import { loadCorpus, reference, compareReplay, parseCandidate } from "./replay";

describe("vt100 spike comparator negative controls", () => {
  test("corpus contains at least twenty deterministic synthetic streams", async () => {
    const corpus = await loadCorpus();
    expect(corpus.streams.length).toBeGreaterThanOrEqual(20);
    expect(new Set(corpus.streams.map(s => s.id)).size).toBe(corpus.streams.length);
    expect(corpus.cols).toBe(120);
    expect(corpus.rows).toBe(40);
  });
  test("detects text, cursor, style, mode and wide-character corruption", async () => {
    const sample = { id: "control", tags: ["negative"], data: "hello 世界\u001b[31m!\u001b[0m\u001b[?2004h", chunkSizes: [1, 2, 3] };
    const baseline = await reference(sample);
    expect((await compareReplay(baseline, baseline.replay)).differences).toEqual([]);
    for (const suffix of ["X", "\u001b[H", "\u001b[1;1H\u001b[32mh", "\u001b[?2004l", "\u001b[1;7HZ"]) {
      expect((await compareReplay(baseline, baseline.replay + suffix)).differences.length).toBeGreaterThan(0);
    }
  });
  test("rejects absent, duplicate, wrong-corpus and non-vt100 candidate records", async () => {
    const corpus = await loadCorpus();
    const valid = {schema:1,engine:"vt100",version:"0.18.1",corpusSha256:corpus.sha256,
      entries:corpus.streams.map(s => ({id:s.id,replayBase64:""}))};
    expect(parseCandidate(valid,corpus).entries.length).toBe(24);
    const duplicate = structuredClone(valid);
    duplicate.entries[1] = duplicate.entries[0]!;
    const wrongId = structuredClone(valid);
    wrongId.entries[0]!.id = "unknown";
    const invalidBase64 = structuredClone(valid);
    invalidBase64.entries[0]!.replayBase64 = "not base64!";
    for (const input of [duplicate,wrongId,invalidBase64,{}, { schema: 1, engine: "xterm" },
      {schema:1,engine:"vt100",version:"0.15.2",corpusSha256:"wrong",entries:[]},
      {schema:1,engine:"vt100",version:"0.15.2",corpusSha256:corpus.sha256,entries:[]}]) {
      expect(() => parseCandidate(input, corpus)).toThrow();
    }
  });
});

test("source preservation and checkpoint parity are separate comparisons", async () => {
  const sample = {id:"origin-oracle",tags:["origin"],data:"\x1b[3;20r\x1b[?6h\x1b[Hinside\r\nrow",chunkSizes:[1,2,3]};
  const source = await reference(sample);
  const restored = await reference({...sample,data:source.replay});
  // A checkpoint compared with itself must pass checkpoint parity even when
  // the existing serializer fails to reproduce the source cursor.
  expect((await compareReplay(restored,source.replay)).differences).toEqual([]);
  expect((await compareReplay(source,source.replay)).differences).toContain("cursorY");
});

test("state comparison detects a lost hidden cursor without browser evidence", async () => {
  const sample = {id:"hidden-cursor",tags:["cursor"],data:"hello\x1b[?25l",chunkSizes:[1,2,3]};
  const source = await reference(sample);
  expect((await compareReplay(source, "hello")).differences).toContain("cursorVisible");
  expect((await compareReplay(source, sample.data)).differences).toEqual([]);
});

test("prospective reference export restores origin cursor and hidden cursor while retaining actual defects", async () => {
  const corpus = await loadCorpus();
  for (const id of ["scroll-region-origin", "alternate-active", "full-screen-redraw"]) {
    const source = await reference(corpus.streams.find(stream => stream.id === id)!);
    expect((await compareReplay(source, source.replay)).differences.length).toBeGreaterThan(0);
    expect((await compareReplay(source, source.prospectiveReplay)).differences).toEqual([]);
  }
});


test("prospective reference retains source state across the full synthetic corpus", async () => {
  const corpus = await loadCorpus();
  for (const stream of corpus.streams) {
    const source = await reference(stream);
    expect((await compareReplay(source, source.prospectiveReplay)).differences).toEqual([]);
  }
});
