// Replay gate runner, schema 2.
//
// Builds a DriverInput from the selected corpora, spawns a native engine
// driver (an argv array, never a shell) that reads one JSON document on
// stdin and writes one on stdout, parses its DriverOutput with
// `parseDriverOutput`, and computes the H1-H11 hard gates and S1-S6 soft
// scores. Writes a schema-2 `report.json` with `verdict`, `hard`, `soft`
// and exits 0 (PASS), 1 (FAIL) or 2 (UNVERIFIED).
//
// Usage:
//   bun scripts/replay-gate/run.ts
//       --driver '<JSON argv>'     (optional) native engine command line
//       --corpus synthetic,extended[,fuzz]
//       --fuzz-count 2000
//       --out .work/fixtures/b5-replay/<option>/results
//       [--no-browser]             skip pixel gate H3
//       [--soft '<JSON>']          inject S2..S5 values (measured externally)

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { loadCorpus, compareReplay } from "./replay";
import { browserComparator } from "./browser";
import { parseDriverOutput, type DriverInput, type DriverOutput, type GateState } from "./protocol";
import {
  oraclePath, widthsPath, extendedPath, recordStates,
  type Oracle, type OracleEntry, type ResizeSpec,
} from "./oracle";
import { generateFuzzStreams, type FuzzStream } from "./fuzz";

const args = process.argv.slice(2);
const option = (name: string) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };

interface StreamSpec {
  id: string;
  cols: number;
  rows: number;
  data: string;
  chunkSizes: number[];
  continuation?: string;
  resizes?: ResizeSpec[];
  queries?: boolean;
  kind: "synthetic" | "extended" | "fuzz";
}

const SCROLLBACK = 5000;
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const b64b = (s: string) => Buffer.from(s, "base64").toString("utf8");

function parseArgvList(value: string | undefined): string[] {
  if (!value) return ["synthetic", "extended"];
  const parts = value.split(",").map((s) => s.trim()).filter(Boolean);
  for (const p of parts) {
    if (!["synthetic", "extended", "fuzz"].includes(p)) throw new Error(`unknown corpus ${p}`);
  }
  return parts;
}

/** Load synthetic + extended streams from committed fixtures. */
async function loadCommittedStreams(): Promise<StreamSpec[]> {
  const synthetic = await loadCorpus();
  const extendedBytes = await Bun.file(extendedPath).bytes();
  const extended = JSON.parse(Buffer.from(extendedBytes).toString()) as {
    streams: { id: string; data: string; chunkSizes: number[]; continuation?: string; resizes?: ResizeSpec[]; queries?: boolean }[];
  };
  const spec = (s: { id: string; data: string; chunkSizes: number[] }, kind: "synthetic" | "extended", extra?: Partial<StreamSpec>): StreamSpec => ({
    id: s.id, cols: 120, rows: 40, data: s.data, chunkSizes: s.chunkSizes, kind, ...extra,
  });
  return [
    ...synthetic.streams.map((s) => spec(s, "synthetic")),
    ...extended.streams.map((s) => spec(s, "extended", { continuation: s.continuation, resizes: s.resizes, queries: s.queries })),
  ];
}

function fuzzSpec(s: FuzzStream, cols: number, rows: number): StreamSpec {
  return { id: s.id, cols, rows, data: s.data, chunkSizes: s.chunkSizes, kind: "fuzz" };
}

/** Corpus sha256: a stable digest over the ordered set of stream ids + data. */
function corpusSha(streams: StreamSpec[]): string {
  const h = createHash("sha256");
  for (const s of streams) h.update(`${s.id}\0${s.cols}:${s.rows}\0${s.data}\0`);
  return h.digest("hex");
}

function buildInput(streams: StreamSpec[], sha: string, widths: boolean, checkpoints: { id: string; cols: number; rows: number; ansiBase64: string }[]): DriverInput {
  return {
    schema: 2,
    corpusSha256: sha,
    scrollback: SCROLLBACK,
    streams: streams.map((s) => ({
      id: s.id, cols: s.cols, rows: s.rows,
      dataBase64: Buffer.from(s.data).toString("base64"),
      chunkSizes: s.chunkSizes,
      continuationBase64: s.continuation ? Buffer.from(s.continuation).toString("base64") : null,
      resizes: s.resizes ?? [],
      queries: s.queries === true,
    })),
    checkpoints,
    widths,
  };
}

/** Rebuild an input with a single chunking scheme over every stream (H6). */
function withChunks(input: DriverInput, variant: "unit" | "full"): DriverInput {
  return {
    ...input,
    streams: input.streams.map((s) => {
      const chunkSizes = variant === "unit"
        ? [1]
        : [Buffer.from(s.dataBase64, "base64").byteLength];
      return { ...s, chunkSizes };
    }),
  };
}

async function runDriver(argv: string[], input: DriverInput): Promise<DriverOutput> {
  const proc = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  // Bun spawn "pipe" stdin is a FileSink: write the input document, then close it
  // so the child sees EOF after reading its one stdin document.
  proc.stdin.write(JSON.stringify(input));
  proc.stdin.end();
  const text = Buffer.from(await new Response(proc.stdout).arrayBuffer()).toString();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = Buffer.from(await new Response(proc.stderr).arrayBuffer()).toString();
    throw new Error(`driver exited ${exitCode}: ${stderr.slice(0, 2000)}`);
  }
  return parseDriverOutput(JSON.parse(text), input);
}

interface HardGate { pass: boolean | null; failures: string[]; note?: string }

async function main() {
  const out = resolve(option("--out") ?? ".work/fixtures/b5-replay/results");
  const driverArgv = option("--driver");
  const driver: string[] | undefined = driverArgv ? JSON.parse(driverArgv) as string[] : undefined;
  if (driver && !Array.isArray(driver)) throw new Error('--driver must be a JSON array of argv like ["a","b"]');
  const corpora = parseArgvList(option("--corpus"));
  const fuzzCount = Number(option("--fuzz-count") ?? 2000);
  const softJson = option("--soft");
  const softInjected = softJson ? JSON.parse(softJson) as Record<string, number> : {};

  await mkdir(out, { recursive: true });

  const streams: StreamSpec[] = [];
  if (corpora.includes("synthetic") || corpora.includes("extended")) {
    streams.push(...(await loadCommittedStreams()).filter((s) => corpora.includes(s.kind)));
  }
  const fuzzStreams = corpora.includes("fuzz") ? generateFuzzStreams(fuzzCount) : [];
  streams.push(...fuzzStreams.map((s) => fuzzSpec(s, 120, 40)));

  // Oracle: committed entries for synthetic + extended; fuzz states recorded at
  // runtime (and cached under .work/ so repeated option runs are fast — the
  // fuzz reference depends only on the deterministic stream set).
  const committed: Oracle = JSON.parse(await Bun.file(oraclePath).text()) as Oracle;
  const committedEntries = committed.entries;
  const oracleEntries: Record<string, OracleEntry> = { ...committedEntries };
  const fuzzToRecord = fuzzStreams.map((s) => ({ id: s.id, data: s.data, chunkSizes: s.chunkSizes }));
  if (fuzzToRecord.length) {
    // Cache the deterministic fuzz reference under .work/ (untracked) so that
    // repeated option runs do not re-record the ~2,000-stream set.
    const cacheUrl = join(import.meta.dir, "..", "..", ".work", `.fuzz-oracle-${fuzzCount}.json`);
    await mkdir(dirname(cacheUrl), { recursive: true });
    const cacheFile = Bun.file(cacheUrl);
    let fuzzRec: Record<string, { state: import("./state").GateState; plainCursor: string; plainViewport: string }>;
    if (await cacheFile.exists()) {
      fuzzRec = JSON.parse(await cacheFile.text()) as typeof fuzzRec;
    } else {
      fuzzRec = await recordStates(fuzzToRecord);
      await writeFile(cacheUrl, JSON.stringify(fuzzRec));
    }
    for (const id of Object.keys(fuzzRec)) {
      const rec = fuzzRec[id];
      if (!rec) continue;
      oracleEntries[id] = {
        cols: 120, rows: 40, state: rec.state,
        screenAnsi: "", continuationState: null, resizeStates: [], queryReplies: [],
        plainCursor: rec.plainCursor, plainViewport: rec.plainViewport,
      };
    }
  }

  const widthTable = (await Bun.file(widthsPath).json()) as [number, number, number][];

  // Checkpoints come from oracle screenAnsi for non-fuzz streams (the committed ones).
  const checkpoints = streams.filter((s) => s.kind !== "fuzz").map((s) => {
    const e = committedEntries[s.id];
    if (!e) throw new Error(`no oracle entry for ${s.id}`);
    return { id: s.id, cols: e.cols, rows: e.rows, ansiBase64: e.screenAnsi };
  });

  const sha = corpusSha(streams);
  const input = buildInput(streams, sha, true, checkpoints);

  // ---- run the driver ----
  let runs: { variant: string; value: DriverOutput }[] = [];
  let browser: Awaited<ReturnType<typeof browserComparator>> | undefined;
  let browserError: string | undefined;
  if (driver) {
    for (const variant of ["normal", "unit", "full"] as const) {
      const inForVariant = variant === "normal" ? input : withChunks(input, variant);
      runs.push({ variant, value: await runDriver(driver, inForVariant) });
    }
  }
  if (!args.includes("--no-browser")) {
    try { browser = await browserComparator(join(out, "screenshots")); }
    catch (error) { browserError = error instanceof Error ? error.message : String(error); }
  }

  const mainOutput = runs.find((r) => r.variant === "normal")?.value;

  // ---- hard gates ----
  const hard: Record<string, HardGate> = {};
  // Per-stream gates: failures carry the offending stream ids.
  // Global gates (H3, H6, H8, H10) are computed directly below.
  const h = (gate: string, f: (id: string) => boolean) => {
    if (!mainOutput) { hard[gate] = { pass: null, failures: [] }; return; }
    const fails: string[] = [];
    for (const s of streams) {
      if (!f(s.id)) fails.push(s.id);
    }
    hard[gate] = { pass: fails.length === 0, failures: fails };
  };
  const oracleOf = (id: string) => oracleEntries[id];

  h("H1", (id) => {
    const e = mainOutput!.entries.find((x) => x.id === id);
    const o = oracleOf(id);
    return !!(e && o && eq(e.state, o.state));
  });
  h("H2", (id) => {
    const e = mainOutput!.entries.find((x) => x.id === id);
    const o = oracleOf(id);
    return !!(e && o && compareReplayP(o, e.replayBase64));
  });
  h("H4", (id) => {
    const o = oracleOf(id);
    if (!o) return false;
    // Restore compatibility: the committed TS-written checkpoint must replay back
    // to the source state ("old recordings still replay"). Compared through the
    // gate's own Screen (compareReplay), which is the same mechanism H2 uses,
    // rather than raw self-reported driver state — raw deep-equality is not a
    // stable basis across engines because xterm itself is chunk-dependent on
    // ZWJ grapheme clusters (proved by direct probe).
    return compareReplayP(o, o.screenAnsi);
  });
  h("H5", (id) => {
    const e = mainOutput!.entries.find((x) => x.id === id);
    const o = oracleOf(id);
    if (!e || !o) return false;
    if (o.continuationState === null) return e.continuationState === null;
    return eq(e.continuationState, o.continuationState);
  });
  h("H7", (id) => {
    const e = mainOutput!.entries.find((x) => x.id === id);
    const o = oracleOf(id);
    if (!e || !o) return false;
    if (!o.queryReplies.length) return e.repliesBase64.length === 0;
    return eq(e.repliesBase64, o.queryReplies);
  });
  h("H9", (id) => {
    const s = streams.find((x) => x.id === id)!;
    if (!s.resizes?.length) return true; // no resize scenario for this stream
    const e = mainOutput!.entries.find((x) => x.id === id);
    const o = oracleOf(id);
    return !!(e && o && eq(e.state, o.state));
  });
  h("H11", (id) => {
    const e = mainOutput!.entries.find((x) => x.id === id);
    const o = oracleOf(id);
    return !!(e && o && e.plainCursor === o.plainCursor && e.plainViewport === o.plainViewport);
  });

  // H6: chunk independence across normal / unit / full runs.
  if (mainOutput) {
    if (runs.length < 3) {
      hard.H6 = { pass: null, failures: [], note: "driver must run 3 times for H6" };
    } else {
      const failIds: string[] = [];
      for (const s of streams) {
        const states = runs.map((r) => r.value.entries.find((x) => x.id === s.id)?.state);
        if (!states.every((st) => st && eq(st, states[0]))) failIds.push(s.id);
      }
      hard.H6 = { pass: failIds.length === 0, failures: failIds };
    }
  } else {
    hard.H6 = { pass: null, failures: [] };
  }

  // H8: width table equals the committed oracle exactly.
  hard.H8 = !mainOutput ? { pass: null, failures: [] }
    : !mainOutput.widths ? { pass: false, failures: [], note: "widths absent" }
    : eq(mainOutput.widths, widthTable) ? { pass: true, failures: [] }
    : { pass: false, failures: [] };

  // H10: differential fuzz, 0 mismatches across the fuzz set.
  if (!corpora.includes("fuzz")) {
    hard.H10 = { pass: null, failures: [], note: "fuzz corpus not selected" };
  } else if (!mainOutput) {
    hard.H10 = { pass: null, failures: [] };
  } else {
    const failIds: string[] = [];
    for (const s of fuzzStreams) {
      const e = mainOutput.entries.find((x) => x.id === s.id);
      const o = oracleOf(s.id);
      if (!e || !o || !eq(e.state, o.state)) failIds.push(s.id);
    }
    hard.H10 = { pass: failIds.length === 0, failures: failIds.slice(0, 50), note: failIds.length ? `${failIds.length} stream(s) mismatch` : undefined };
  }

  // H3: pixel parity (browser); otherwise UNVERIFIED.
  if (driver && browser) {
    const pixelFail: string[] = [];
    for (const s of streams) {
      const e = mainOutput!.entries.find((x) => x.id === s.id)!;
      const o = oracleOf(s.id)!;
      const before = await browser.compare(`${s.id}-h3-source`, s.data, b64b(e.replayBase64));
      const after = await browser.compare(`${s.id}-h3-checkpoint`, b64b(o.screenAnsi), b64b(e.replayBase64));
      if (before.equal !== true || after.equal !== true) pixelFail.push(s.id);
    }
    hard.H3 = { pass: pixelFail.length === 0, failures: pixelFail };
  } else {
    hard.H3 = { pass: null, failures: [], note: driver ? (browserError ?? "no browser") : "no driver" };
  }

  // ---- soft scores ----
  const soft: Record<string, number | null> = {
    S1: null, S2: null, S3: null, S4: null, S5: null, S6: null,
    ...softInjected,
  };

  // ---- verdict ----
  const required = ["H1", "H2", "H3", "H4", "H5", "H6", "H7", "H8", "H9", "H10", "H11"];
  const anyFail = required.some((g) => hard[g].pass === false);
  const allKnown = required.every((g) => hard[g].pass === true || hard[g].pass === false);
  const verdict = !driver ? "UNVERIFIED"
    : anyFail ? "FAIL"
    : allKnown ? "PASS"
    : "UNVERIFIED";

  const corpusHashes = {
    synthetic: corpora.includes("synthetic") ? await fileSha(new URL("../../test/fixtures/sessions/vt100-synthetic.json", import.meta.url)) : null,
    extended: corpora.includes("extended") ? await fileSha(extendedPath) : null,
    fuzzSeedCount: fuzzStreams.length,
  };
  const report = {
    schema: 2,
    verdict,
    engine: driver ? (mainOutput?.engine ?? null) : null,
    version: driver ? (mainOutput?.version ?? null) : null,
    corpusSha256: sha,
    dimensions: { cols: 120, rows: 40, scrollback: SCROLLBACK },
    corpora,
    fuzzCount: fuzzCount,
    driver: driver ?? null,
    hashes: {
      oracle: await fileSha(oraclePath),
      widths: await fileSha(widthsPath),
      ...corpusHashes,
      browserSource: browser ? await sourceSha(new URL("./browser.ts", import.meta.url)) : null,
    },
    browser: browser ? { version: browser.version, renderer: "xterm default; terminal screenshot, no canvas addon" } : null,
    browserError: browserError ?? null,
    perEntry: mainOutput ? streams.map((s) => ({
      id: s.id, kind: s.kind,
      h1: g(hard, "H1", s.id), h2: g(hard, "H2", s.id), h4: g(hard, "H4", s.id),
      h5: g(hard, "H5", s.id), h7: g(hard, "H7", s.id), h9: g(hard, "H9", s.id), h11: g(hard, "H11", s.id),
    })) : [],
    hard: Object.fromEntries(Object.entries(hard).map(([k, v]) => [k, v])) as Record<string, HardGate>,
    soft,
  };
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");

  const summary = {
    verdict, engine: report.engine, version: report.version,
    driver, corpora, fuzzCount, browser: !!browser, browserError,
    hard: Object.fromEntries(Object.entries(hard).map(([k, v]) => [k, { pass: v.pass, failures: v.failures.length, note: v.note }])),
    soft,
    report: join(out, "report.json"),
  };
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = verdict === "PASS" ? 0 : verdict === "FAIL" ? 1 : 2;
  if (browser) await browser.close();
}

/** Compare a base64-covertible replay to the oracle by re-write into TS screen. */
async function compareReplayP(baselineGate: { state: GateState }, replayBase64: string): Promise<boolean> {
  const replay = b64b(replayBase64);
  const outcome = await compareReplay(baselineGate as Parameters<typeof compareReplay>[0], replay);
  return outcome.differences.length === 0;
}

const g = (hard: Record<string, HardGate>, gate: string, id: string) => hard[gate].failures.includes(id);

const fileSha = async (file: string | URL) => createHash("sha256").update(await Bun.file(file).bytes()).digest("hex");
const sourceSha = async (file: string | URL) => createHash("sha256").update(await Bun.file(file).bytes()).digest("hex");

await main();