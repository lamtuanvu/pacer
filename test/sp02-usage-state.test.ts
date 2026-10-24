import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, writeFile, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createCallAuthority, type CallAuthority } from "../src/plugins/authority";
import { answerUsageState } from "../src/plugins/usage-state";
import { fakeCtx } from "./helpers";
const authorities: CallAuthority[] = [];
afterEach(async () => { await Promise.all(authorities.splice(0).map(a => a.revoke())); });
function setup(kind: "cache" | "cursors" = "cache", ctx = fakeCtx()) {
  const root = join(ctx.home, "sessions");
  const path = join(ctx.pacerHome, kind === "cache" ? "cache/provider.json" : "state/codex-cursors.json");
  const authority = createCallAuthority(ctx, { reads: [], commands: [], stores: [{ id: "fixture", path, kind, version: kind === "cursors" ? 4 : undefined, root }] }, { deadlineMs: Date.now() + 30000, grants: ["usage.state"] });
  authorities.push(authority);
  return { ctx, root, path, authority };
}
async function call(a: CallAuthority, op: "begin" | "readChunk" | "stageChunk" | "commit" | "release", p: Record<string, unknown>) {
  return await answerUsageState(a, op, op === "commit" ? { dirty: true, ...p } : p) as Record<string, any>;
}
async function snapshot(a: CallAuthority) {
  const begin = await call(a, "begin", { store: "fixture" });
  const buffers = [];
  for (let offset = 0; offset < begin.bytes; offset += 262144) {
    const chunk = await call(a, "readChunk", { lease: begin.lease, offset, length: Math.min(262144, begin.bytes - offset) });
    buffers.push(Buffer.from(chunk.base64, "base64"));
  }
  return { lease: begin.lease, value: JSON.parse(Buffer.concat(buffers).toString()), dirty: begin.dirty };
}
async function stage(a: CallAuthority, lease: string, value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  for (let offset = 0; offset < bytes.length; offset += 262144) await call(a, "stageChunk", { lease, offset, base64: bytes.subarray(offset, offset + 262144).toString("base64") });
}
test("cache opaque lease preserves compatibility JSON and private atomic replacement", async () => {
  const s = setup();
  const initial = await snapshot(s.authority);
  expect(initial.value).toBe(null);
  const value = { capturedAt: s.ctx.now, value: { items: ["value"], unknown: true } };
  await stage(s.authority, initial.lease, value);
  expect(await call(s.authority, "commit", { lease: initial.lease })).toEqual({ saved: true });
  expect(JSON.parse(await readFile(s.path, "utf8"))).toEqual(value);
  expect((await stat(s.path)).mode & 0o777).toBe(0o600);
  expect((await stat(join(s.ctx.pacerHome, "cache"))).mode & 0o777).toBe(0o700);
  expect((await snapshot(s.authority)).value).toEqual(value);
});
test("state refuses missing grants, unknown stores, cross-call leases, invalid chunks and expired authority", async () => {
  const s = setup(); const other = setup();
  await expect(call(s.authority, "begin", { store: s.path })).rejects.toMatchObject({ code: "capability_denied" });
  const lease = (await snapshot(s.authority)).lease;
  await expect(call(other.authority, "readChunk", { lease, offset: 0, length: 1 })).rejects.toMatchObject({ code: "capability_denied" });
  for (const p of [{ offset: -1, length: 1 }, { offset: 0, length: 262145 }]) await expect(call(s.authority, "readChunk", { lease, ...p })).rejects.toMatchObject({ code: "invalid_input" });
  await expect(call(s.authority, "stageChunk", { lease, offset: 1, base64: "e30=" })).rejects.toMatchObject({ code: "invalid_input" });
  await expect(call(s.authority, "stageChunk", { lease, offset: 0, base64: "!!!!" })).rejects.toMatchObject({ code: "invalid_input" });
  await s.authority.revoke();
  await expect(call(s.authority, "commit", { lease })).rejects.toMatchObject({ code: "capability_denied" });
  const denied = createCallAuthority(s.ctx, s.authority.resources as any, { deadlineMs: Date.now() + 30000 }); authorities.push(denied);
  await expect(call(denied, "begin", { store: "fixture" })).rejects.toMatchObject({ code: "capability_denied" });
});
test("cursor global lease projects account roots, serializes calls, and merges large rich state", async () => {
  const s = setup("cursors"); await mkdir(s.root, { recursive: true }); await mkdir(join(s.ctx.pacerHome, "state"), { recursive: true });
  const log = join(s.root, "rollout-a.jsonl"); await writeFile(log, "{}\n");
  const otherPath = join(s.ctx.home, "other", "rollout-b.jsonl");
  const cursor = { size: 3, mtime: 1, inode: 2, offset: 3, aggregate: { last: { rateLimits: { primary: { used_percent: 20 } }, observedAt: 123, alternatives: [{ rateLimits: { primary: { used_percent: 30 }, unknown: "é".repeat(2_200_000) }, observedAt: 123 }] }, unknown: true } };
  await writeFile(s.path, JSON.stringify({ version: 4, files: { [log]: cursor, [otherPath]: cursor } }));
  const first = await snapshot(s.authority);
  expect(Object.keys(first.value.files)).toEqual([log]);
  expect(first.value.files[log]).toEqual(cursor);
  const b = setup("cursors", s.ctx);
  let entered = false;
  const pending = snapshot(b.authority).then(value => { entered = true; return value; });
  await Bun.sleep(15); expect(entered).toBe(false);
  await stage(s.authority, first.lease, { version: 4, files: {} });
  expect(await call(s.authority, "commit", { lease: first.lease })).toEqual({ saved: true });
  const second = await pending;
  expect(second.value).toEqual({ version: 4, files: {} });
  const full = JSON.parse(await readFile(s.path, "utf8"));
  expect(full.files[otherPath]).toEqual(cursor); expect(full.files[log]).toBeUndefined();
});
test("readOnly cursor updates survive in memory and writable successor retries persistence", async () => {
  const s = setup("cursors"); s.ctx.readOnly = true;
  await mkdir(s.root, { recursive: true }); const log = join(s.root, "rollout-a.jsonl"); await writeFile(log, "{}\n");
  const first = await snapshot(s.authority);
  const value = { version: 4, files: { [log]: { size: 3, mtime: 1, inode: 2, offset: 3, aggregate: { last: null } } } };
  await stage(s.authority, first.lease, value);
  expect(await call(s.authority, "commit", { lease: first.lease })).toEqual({ saved: false });
  expect(await Bun.file(s.path).exists()).toBe(false);
  s.ctx.readOnly = false;
  const second = await snapshot(s.authority); expect(second.value).toEqual(value);
  await stage(s.authority, second.lease, second.value);
  expect(await call(s.authority, "commit", { lease: second.lease })).toEqual({ saved: true });
  expect(JSON.parse(await readFile(s.path, "utf8"))).toEqual(value);
});
test("revoking a cursor lease releases blocked successor and removes private staging", async () => {
  const s = setup("cursors"); await mkdir(s.root, { recursive: true });
  const first = await snapshot(s.authority);
  await stage(s.authority, first.lease, { version: 4, files: {} });
  const b = setup("cursors", s.ctx); const pending = snapshot(b.authority);
  await s.authority.revoke();
  const next = await pending; expect(next.value).toEqual({ version: 4, files: {} });
  await expect(call(s.authority, "commit", { lease: first.lease })).rejects.toMatchObject({ code: "capability_denied" });
  await call(b.authority, "release", { lease: next.lease });
});

test("cache cold start rereads disk and readOnly commits do not replace observations", async () => {
  const s = setup(); await mkdir(join(s.ctx.pacerHome, "cache"), { recursive: true });
  const value = { capturedAt: 100, value: { rich: true } }; await writeFile(s.path, JSON.stringify(value));
  const first = await snapshot(s.authority); expect(first.value).toEqual(value);
  s.ctx.readOnly = true; await stage(s.authority, first.lease, { capturedAt: 200, value: {} });
  expect(await call(s.authority, "commit", { lease: first.lease })).toEqual({ saved: false });
  expect(JSON.parse(await readFile(s.path, "utf8"))).toEqual(value);
  const replacement = { capturedAt: 300, value: { external: true } }; await writeFile(s.path, JSON.stringify(replacement));
  expect((await snapshot(s.authority)).value).toEqual(replacement);
});
test("cache persistence failures propagate while cursor failures preserve dirty memory for retry", async () => {
  const cache = setup(); await mkdir(cache.path, { recursive: true });
  const a = await snapshot(cache.authority); await stage(cache.authority, a.lease, { capturedAt: 1, value: true });
  await expect(call(cache.authority, "commit", { lease: a.lease })).rejects.toBeDefined();
  const s = setup("cursors"); await mkdir(s.path, { recursive: true }); await mkdir(s.root, { recursive: true });
  const log = join(s.root, "rollout-a.jsonl"); await writeFile(log, "{}\n");
  const value = { version: 4, files: { [log]: { size: 3, mtime: 1, inode: 2, offset: 3, aggregate: { last: null } } } };
  const first = await snapshot(s.authority); await stage(s.authority, first.lease, value);
  expect(await call(s.authority, "commit", { lease: first.lease })).toEqual({ saved: false });
  await (await import("node:fs/promises")).rm(s.path, { recursive: true });
  const next = await snapshot(s.authority); expect(next.value).toEqual(value);
  await stage(s.authority, next.lease, next.value);
  expect(await call(s.authority, "commit", { lease: next.lease })).toEqual({ saved: true });
  expect(JSON.parse(await readFile(s.path, "utf8"))).toEqual(value);
});
test("cursor invalid JSON, wrong version, unauthorized paths and invalid entries never overwrite prior disk", async () => {
  for (const value of [{ version: 3, files: {} }, { version: 4, files: { "/outside/rollout-x.jsonl": { size: 0, mtime: 0, inode: 0, offset: 0, aggregate: {} } } },
    { version: 4, files: { "/outside/rollout-x.jsonl": {} } }]) {
    const s = setup("cursors"); await mkdir(s.root, { recursive: true });
    const first = await snapshot(s.authority); await stage(s.authority, first.lease, value);
    await expect(call(s.authority, "commit", { lease: first.lease })).rejects.toBeDefined();
    expect(await Bun.file(s.path).exists()).toBe(false);
  }
  const s = setup("cursors"); await mkdir(s.root, { recursive: true });
  const first = await snapshot(s.authority);
  await call(s.authority, "stageChunk", { lease: first.lease, offset: 0, base64: Buffer.from('{"version":4,"files":{').toString("base64") });
  await expect(call(s.authority, "commit", { lease: first.lease })).rejects.toMatchObject({ code: "invalid_input" });
  expect(await Bun.file(s.path).exists()).toBe(false);
});
test("cancelling a queued lease does not bypass the holder or block the next successor", async () => {
  const s = setup("cursors"); await mkdir(s.root, { recursive: true }); const first = await snapshot(s.authority);
  const cancelled = setup("cursors", s.ctx); const queued = snapshot(cancelled.authority);
  const outcome = queued.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
  await cancelled.authority.revoke();
  expect((await outcome).error).toMatchObject({ code: "capability_denied" });
  const next = setup("cursors", s.ctx); let entered = false;
  const waiting = snapshot(next.authority).then(result => { entered = true; return result; });
  await Bun.sleep(10); expect(entered).toBe(false);
  await call(s.authority, "release", { lease: first.lease });
  expect((await waiting).value).toEqual({ version: 4, files: {} });
});

test("state refuses final-file and parent symlinks without reading or changing outside state", async () => {
  const { symlink } = await import("node:fs/promises");
  for (const parent of [false, true]) {
    const s = setup(); const outside = join(s.ctx.home, "outside"); await mkdir(outside, { recursive: true });
    const secret = join(outside, "provider.json"); await writeFile(secret, '{"capturedAt":1,"value":"must-not-read"}');
    if (parent) { await mkdir(s.ctx.pacerHome, { recursive: true }); await symlink(outside, join(s.ctx.pacerHome, "cache")); }
    else { await mkdir(join(s.ctx.pacerHome, "cache"), { recursive: true }); await symlink(secret, s.path); }
    await expect(snapshot(s.authority)).rejects.toMatchObject({ code: "capability_denied" });
    expect(await readFile(secret, "utf8")).toBe('{"capturedAt":1,"value":"must-not-read"}');
  }
});

test("one lease admits only one outstanding chunk operation", async () => {
  const s = setup(); const lease = (await snapshot(s.authority)).lease;
  const first = call(s.authority, "readChunk", { lease, offset: 0, length: 4 });
  const second = call(s.authority, "readChunk", { lease, offset: 0, length: 4 });
  const results = await Promise.allSettled([first, second]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
});

test("cold process reads compatible cursor state without changing unknown aggregate fields", async () => {
  const s = setup("cursors"); await mkdir(s.root, { recursive: true });
  await mkdir(join(s.ctx.pacerHome, "state"), { recursive: true });
  const log = join(s.root, "rollout-cold.jsonl"); await writeFile(log, "{}\n");
  const value = { version: 4, files: { [log]: { size: 3, mtime: 1, inode: 2, offset: 3,
    aggregate: { last: { rateLimits: { primary: { used_percent: 12 }, unknown: ["é", "quote\"", null] }, observedAt: 123, alternatives: [] } } } } };
  await writeFile(s.path, JSON.stringify(value));
  const script = `import {createCallAuthority} from ${JSON.stringify(new URL("../src/plugins/authority.ts", import.meta.url).pathname)};
    import {answerUsageState} from ${JSON.stringify(new URL("../src/plugins/usage-state/index.ts", import.meta.url).pathname)};
    const ctx=${JSON.stringify(s.ctx)}; const a=createCallAuthority(ctx,{reads:[],commands:[],stores:[${JSON.stringify(s.authority.resources.stores[0])}]},{deadlineMs:Date.now()+10000,grants:['usage.state']});
    try { const b=await answerUsageState(a,'begin',{store:'fixture'}); const r=await answerUsageState(a,'readChunk',{lease:b.lease,offset:0,length:b.bytes}); console.log(Buffer.from(r.base64,'base64').toString()); } finally {await a.revoke();}`;
  const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, HOME: s.ctx.home, PACER_HOME: s.ctx.pacerHome }, stdout: "pipe", stderr: "pipe" });
  const [code, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, error }).toEqual({ code: 0, error: "" }); expect(JSON.parse(out)).toEqual(value);
  expect(JSON.parse(await readFile(s.path, "utf8"))).toEqual(value);
});

test("revocation waits for an admitted atomic replacement before releasing global cursor lease", async () => {
  const { spyOn } = await import("bun:test");
  const fs = await import("node:fs/promises");
  const s = setup("cursors"); await mkdir(s.root, { recursive: true });
  const log = join(s.root, "rollout-atomic.jsonl"); await writeFile(log, "{}\n");
  const first = await snapshot(s.authority);
  const value = { version: 4, files: { [log]: { size: 3, mtime: 1, inode: 2, offset: 3, aggregate: { last: null } } } };
  await stage(s.authority, first.lease, value);
  let admit!: () => void; const admitted = new Promise<void>(resolve => { admit = resolve; });
  let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; });
  const rename = fs.rename;
  const spy = spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (to === s.path) { admit(); await gate; }
    return rename(from, to);
  });
  try {
    const committing = call(s.authority, "commit", { lease: first.lease });
    await admitted;
    let cleaned = false; const revoke = s.authority.revoke().then(() => { cleaned = true; });
    const b = setup("cursors", s.ctx); let entered = false; const successor = snapshot(b.authority).then(result => { entered = true; return result; });
    await Bun.sleep(10); expect(cleaned).toBe(false); expect(entered).toBe(false);
    finish(); expect(await committing).toEqual({ saved: true }); await revoke;
    expect((await successor).value).toEqual(value); expect(cleaned).toBe(true);
    expect(JSON.parse(await readFile(s.path, "utf8"))).toEqual(value);
  } finally { finish(); spy.mockRestore(); }
});

test("disk-reserve refusal leaves prior committed state intact and cleans staging on revoke", async () => {
  const { spyOn } = await import("bun:test"); const fs = await import("node:fs/promises");
  const s = setup(); await mkdir(join(s.ctx.pacerHome, "cache"), { recursive: true });
  const prior = '{"capturedAt":1,"value":"old"}'; await writeFile(s.path, prior);
  const first = await snapshot(s.authority);
  const actual = fs.statfs;
  const spy = spyOn(fs, "statfs").mockImplementation(async (...args: Parameters<typeof fs.statfs>) => ({ ...await actual(...args), bavail: 0 }) as any);
  try {
    await expect(stage(s.authority, first.lease, { capturedAt: 2, value: "new" })).rejects.toMatchObject({ code: "plugin_unavailable" });
    expect(await readFile(s.path, "utf8")).toBe(prior);
  } finally { spy.mockRestore(); }
  await s.authority.revoke();
  expect((await readdir(join(s.ctx.pacerHome, "cache"))).filter(name => name.startsWith(".pacer-usage-state-"))).toEqual([]);
});
test("cache calls keep last-atomic-writer concurrency without acquiring a cursor lease", async () => {
  const s = setup(); const other = setup("cache", s.ctx);
  const [first, second] = await Promise.all([snapshot(s.authority), snapshot(other.authority)]);
  expect(first.value).toBe(null); expect(second.value).toBe(null);
  await stage(s.authority, first.lease, { capturedAt: 1, value: "first" });
  await stage(other.authority, second.lease, { capturedAt: 2, value: "second" });
  await call(other.authority, "commit", { lease: second.lease }); await call(s.authority, "commit", { lease: first.lease });
  expect(JSON.parse(await readFile(s.path, "utf8"))).toEqual({ capturedAt: 1, value: "first" });
});

test("two account roots share one global lease and retain each other's cursor entries", async () => {
  const s = setup("cursors"); const secondRoot = join(s.ctx.home, "account-b", "sessions");
  await mkdir(s.root, { recursive: true }); await mkdir(secondRoot, { recursive: true });
  const aLog = join(s.root, "rollout-a.jsonl"), bLog = join(secondRoot, "rollout-b.jsonl");
  await writeFile(aLog, "{}\n"); await writeFile(bLog, "{}\n");
  const b = createCallAuthority(s.ctx, { reads: [], commands: [], stores: [{ id: "fixture", kind: "cursors", path: s.path, version: 4, root: secondRoot }] }, { deadlineMs: Date.now() + 30000, grants: ["usage.state"] }); authorities.push(b);
  const cursor = { size: 3, mtime: 1, inode: 2, offset: 3, aggregate: { unknown: true } };
  const first = await snapshot(s.authority); await stage(s.authority, first.lease, { version: 4, files: { [aLog]: cursor } });
  await call(s.authority, "commit", { lease: first.lease });
  const second = await snapshot(b); expect(second.value.files).toEqual({});
  await stage(b, second.lease, { version: 4, files: { [bLog]: cursor } }); await call(b, "commit", { lease: second.lease });
  expect(JSON.parse(await readFile(s.path, "utf8")).files).toEqual({ [aLog]: cursor, [bLog]: cursor });
  const aAgain = await snapshot(s.authority); expect(aAgain.value.files).toEqual({ [aLog]: cursor });
});

test("unchanged cursor commits skip atomic writes while retained dirty state retries unchanged projections", async () => {
  const { spyOn } = await import("bun:test"); const fs = await import("node:fs/promises");
  const s = setup("cursors"); await mkdir(s.root, { recursive: true });
  const log = join(s.root, "rollout-noop.jsonl"); await writeFile(log, "{}\n");
  const value = { version: 4, files: { [log]: { size: 3, mtime: 1, inode: 2, offset: 3, aggregate: { last: null } } } };
  s.ctx.readOnly = true;
  const initial = await snapshot(s.authority); expect(initial.dirty).toBe(false);
  await stage(s.authority, initial.lease, value); await call(s.authority, "commit", { lease: initial.lease, dirty: true });
  s.ctx.readOnly = false;
  const retry = await snapshot(s.authority); expect(retry.dirty).toBe(true);
  await stage(s.authority, retry.lease, retry.value);
  expect(await call(s.authority, "commit", { lease: retry.lease, dirty: false })).toEqual({ saved: true });
  const noOp = await snapshot(s.authority); expect(noOp.dirty).toBe(false);
  await stage(s.authority, noOp.lease, noOp.value);
  const spy = spyOn(fs, "rename").mockImplementation(async () => { throw new Error("unchanged cursor must not be persisted"); });
  try { expect(await call(s.authority, "commit", { lease: noOp.lease, dirty: false })).toEqual({ saved: true }); expect(spy).not.toHaveBeenCalled(); }
  finally { spy.mockRestore(); }
});

test("streamed cursor decoding matches source replacement UTF8 and strict JSON whitespace", async () => {
  const { CursorStore } = await import("../src/usage/cursors");
  for (const bom of [false, true]) {
    const s = setup("cursors"); await mkdir(s.root, { recursive: true }); await mkdir(join(s.ctx.pacerHome, "state"), { recursive: true });
    const log = join(s.root, "rollout-encoding.jsonl"); await writeFile(log, "{}\n");
    const cursor = { size: 3, mtime: 1, inode: 2, offset: 3, aggregate: { extra: "MARKER" } };
    const text = JSON.stringify({ version: 4, files: { [log]: cursor } });
    const bytes = bom ? Buffer.from("\uFEFF" + text) : Buffer.concat([Buffer.from(text.split("MARKER")[0]), Buffer.from([255]), Buffer.from(text.split("MARKER")[1])]);
    await writeFile(s.path, bytes);
    const source = new CursorStore<Record<string, unknown>>(s.path, () => true, 4);
    const expected = await source.run(s.ctx, async files => ({ version: 4, files: JSON.parse(JSON.stringify(files)) }));
    expect((await snapshot(s.authority)).value).toEqual(expected);
  }
});

test("streamed duplicate files keys follow JSON.parse last-value semantics", async () => {
  const { CursorStore } = await import("../src/usage/cursors");
  for (const raw of [
    '{"version":4,"files":null,"files":{}}', '{"version":4,"files":17,"files":{}}',
    '{"version":4,"files":[],"files":{}}', '{"version":4,"files":{},"files":null}',
    '{"version":4,"files":{},"files":[]}', '{"version":4,"files":{},"files":17}',
  ]) {
    const s = setup("cursors"); await mkdir(s.root, { recursive: true }); await mkdir(join(s.ctx.pacerHome, "state"), { recursive: true });
    const log = join(s.root, "rollout-duplicate.jsonl"); await writeFile(log, "{}\n");
    const cursor = { size: 3, mtime: 1, inode: 2, offset: 3, aggregate: { marker: "retained" } };
    const object = JSON.stringify({ [log]: cursor });
    // Nonempty final objects make an eager rejection visibly different from JSON.parse.
    const text = raw.replace('"files":{}}', '"files":' + object + '}');
    await writeFile(s.path, text);
    const source = new CursorStore(s.path, () => true, 4);
    const expected = await source.run(s.ctx, async files => ({ version: 4, files: JSON.parse(JSON.stringify(files)) }));
    expect((await snapshot(s.authority)).value).toEqual(expected);
  }
});
