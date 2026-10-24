import { expect, test } from "bun:test";
import type { HostClient } from "../packages/plugin-sdk/src";

function stateHost(snapshot: unknown, dirty = false) {
  let staged = Buffer.alloc(0), committed: unknown, marker: unknown, released = false, consumed = false;
  const calls: string[] = [];
  const host: HostClient = { log: async () => {}, config: async () => ({}), call: async <T>(method: string, params: any): Promise<T> => {
    calls.push(method);
    if (consumed && method.endsWith(".release")) throw Error("lease already consumed by commit");
    const bytes = Buffer.from(JSON.stringify(snapshot));
    if (method.endsWith(".begin")) return { lease: "fixture-lease", bytes: bytes.length, dirty } as T;
    if (method.endsWith(".readChunk")) return { base64: bytes.subarray(params.offset, params.offset + params.length).toString("base64") } as T;
    if (method.endsWith(".stageChunk")) { expect(params.offset).toBe(staged.length); staged = Buffer.concat([staged, Buffer.from(params.base64, "base64")]); return { bytes: staged.length } as T; }
    if (method.endsWith(".commit")) { consumed = true; marker = params.dirty; committed = JSON.parse(staged.toString()); return { saved: true } as T; }
    if (method.endsWith(".release")) { released = true; return { ok: true } as T; }
    throw Error(`unexpected ${method}`);
  } };
  return { host, calls, get committed() { return committed; }, get marker() { return marker; }, get released() { return released; } };
}

test("SDK cursor hydration honors provider validator and proxy identity dirty semantics", async () => {
  const { createUsageReaderIO } = await import("../packages/plugin-sdk/src/usage");
  const cursor = (aggregate: unknown) => ({ size: 8, mtime: 2, inode: 3, offset: 8, aggregate });
  const fixture = stateHost({ version: 4, files: { good: cursor({ valid: true }), bad: cursor({ valid: false }) } });
  const io = createUsageReaderIO(fixture.host);
  const value = await io.cursors("codex-cursors", 4, x => (x as any)?.valid === true, async files => {
    expect(Object.keys(files)).toEqual(["good"]);
    files.good = files.good;
    return 17;
  });
  expect(value).toBe(17); expect(fixture.marker).toBe(false); expect(fixture.released).toBe(false);
  expect(fixture.committed).toEqual({ version: 4, files: { good: cursor({ valid: true }) } });
});

test("SDK preserves >4MiB cursor state via bounded chunks and marks reference replacement dirty", async () => {
  const { createUsageReaderIO } = await import("../packages/plugin-sdk/src/usage");
  const aggregate = { payload: "界".repeat(1500000) };
  const fixture = stateHost({ version: 4, files: { large: { size: 1, mtime: 1, inode: 1, offset: 1, aggregate } } });
  const io = createUsageReaderIO(fixture.host);
  await io.cursors("codex-cursors", 4, () => true, async files => { files.large = { ...files.large! }; });
  expect((fixture.committed as any).files.large.aggregate).toEqual(aggregate);
  expect(fixture.marker).toBe(true);
  expect(fixture.calls.filter(x => x.endsWith(".stageChunk")).length).toBeGreaterThan(16);
});

test("cache refresh persistence failures retain source stale fallback and backward-clock behavior", async () => {
  const { createUsageReaderIO } = await import("../packages/plugin-sdk/src/usage");
  const fixture = stateHost({ capturedAt: 100, value: { old: true } });
  const original = fixture.host.call;
  fixture.host.call = async (method, params) => { if (method.endsWith(".commit")) throw Error("disk unavailable"); return original(method, params); };
  const io = createUsageReaderIO(fixture.host);
  expect(await io.cachedFetch<Record<string, boolean>>("arkcli-usage-plan", 600, 21600, async () => ({ fresh: true }), { now: 101, refresh: true }))
    .toEqual({ value: { old: true }, capturedAt: 100, stale: true, error: "disk unavailable" });
  const backward = stateHost({ capturedAt: 100, value: { old: true } });
  expect(await createUsageReaderIO(backward.host).cachedFetch("arkcli-usage-plan", 600, 21600, async () => { throw Error("offline"); }, { now: 99 }))
    .toEqual({ value: null, capturedAt: null, stale: false, error: "offline" });
});

test("SDK handles disappeared ranged files and refuses incomplete bytes", async () => {
  const { createUsageReaderIO } = await import("../packages/plugin-sdk/src/usage");
  const info = { path: "/fixture", size: 4, mtimeMs: 1, inode: 1, device: 1 };
  const host = stateHost(null).host;
  host.call = async <T>(method: string): Promise<T> => method === "capability.fs.read" ? { ranged: info } as T : { missing: true } as T;
  await expect(createUsageReaderIO(host).range(info.path, 0, 4, info)).rejects.toMatchObject({ code: "ENOENT" });
  host.call = async <T>(method: string): Promise<T> => method === "capability.fs.read" ? { ranged: info } as T : { base64: "eA==", info } as T;
  await expect(createUsageReaderIO(host).read(info.path)).rejects.toThrow("incomplete");
});
