import { expect, test } from "bun:test";
import { createFileSystem, type Dependencies } from "../packages/plugin-sdk/src/fs";

function fixture(options: { negotiated?: boolean; metadata?: number; signal?: AbortSignal; override?: (method: string, params: any) => unknown } = {}) {
  const calls: { method: string; params: any }[] = [], written: Buffer[] = [];
  let chunks: Buffer[] = [], offset = 0;
  const fits = (method: string, params: unknown) => Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: "p123", method, params, _meta: { capabilityCall: "m".repeat(options.metadata ?? 0) } }) + "\n") <= 1048576;
  const call: Dependencies["call"] = async (method, params: any) => {
    expect(fits(method, params)).toBe(true);
    calls.push({ method, params });
    if (options.override) {
      const value = await options.override(method, params);
      if (value !== undefined) return await value;
    }
    if (method.endsWith(".beginWrite")) { chunks = []; offset = 0; return { handle: "owned-handle" }; }
    if (method.endsWith(".writeChunk")) {
      const bytes = Buffer.from(params.base64, "base64");
      expect(bytes.toString("base64")).toBe(params.base64);
      expect(bytes.length).toBeLessThanOrEqual(262144);
      expect(params.offset).toBe(offset);
      chunks.push(bytes); offset += bytes.length; return { bytes: offset };
    }
    if (method.endsWith(".commitWrite")) { written.push(Buffer.concat(chunks)); return { ok: true }; }
    if (method === "capability.fs.write") written.push(Buffer.from(params.text));
    return { ok: true };
  };
  return { fs: createFileSystem({ call, cleanupCall: call, fits, negotiated: () => options.negotiated ?? true, signal: options.signal }), calls, written };
}
test("small and empty writes, mkdir and remove use exact inline requests", async () => {
  const f = fixture();
  await f.fs.write("/owned/a", "", 0o600);
  await f.fs.mkdir("/owned/dir");
  await f.fs.remove("/owned/dir", true);
  expect(f.calls.map(c => [c.method, c.params])).toEqual([
    ["capability.fs.write", { path: "/owned/a", text: "", mode: 0o600 }],
    ["capability.fs.mkdir", { path: "/owned/dir" }],
    ["capability.fs.remove", { path: "/owned/dir", recursive: true }],
  ]);
});
for (const name of ["multibyte BOM", "NUL JSON expansion"]) test(`full4MiB ${name} survives negotiated writes`, async () => {
  const text = name === "multibyte BOM" ? "\ufeff" + "界".repeat(1398100) + "x" : "\0".repeat(4194304);
  expect(Buffer.byteLength(text)).toBe(4194304);
  const f = fixture({ metadata: 820000 });
  await f.fs.write("/owned/large", text);
  expect(f.written).toHaveLength(1);
  expect(f.written[0]!.equals(Buffer.from(text))).toBe(true);
  expect(f.calls.some(c => c.method.endsWith(".releaseWrite"))).toBe(false);
});
test("invalid mode, over4MiB and old-peer oversized writes fail before effects", async () => {
  const f = fixture({ negotiated: false });
  await expect(f.fs.write("/owned/a", "x", 0o644 as 0o600)).rejects.toThrow();
  await expect(f.fs.write("/owned/a", "界".repeat(1398102))).rejects.toThrow();
  await expect(f.fs.write("/owned/a", "\0".repeat(300000))).rejects.toThrow();
  expect(f.calls).toEqual([]);
});
test("unencodable path/descriptor fails before begin", async () => {
  const f = fixture({ metadata: 1048500 });
  await expect(f.fs.write("/owned/a", "\0".repeat(300000))).rejects.toThrow();
  expect(f.calls).toEqual([]);
});
test("bad byte acknowledgements release staging without committing", async () => {
  const f = fixture({ override: method => method.endsWith(".writeChunk") ? { bytes: 1 } : undefined });
  await expect(f.fs.write("/owned/a", "\0".repeat(300000))).rejects.toThrow("acknowledgement");
  expect(f.calls.at(-1)!.method).toBe("capability.fs.releaseWrite");
  expect(f.written).toEqual([]);
});
test("invalid ok replies are rejected for all inline methods", async () => {
  const f = fixture({ override: () => ({ ok: "true" }) });
  for (const operation of [() => f.fs.write("/owned/a", "x"), () => f.fs.mkdir("/owned/a"), () => f.fs.remove("/owned/a")]) await expect(operation()).rejects.toThrow();
});
test("whole transactions await cleanup; queued abort has no capability effects", async () => {
  const controller = new AbortController();
  let entered!: () => void, finish!: () => void, released = false;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const barrier = new Promise<void>(resolve => { finish = resolve; });
  const f = fixture({ signal: controller.signal, override: async method => {
    if (method.endsWith(".writeChunk")) { entered(); await barrier; throw Error("owned stage failure"); }
    if (method.endsWith(".releaseWrite")) { released = true; return { ok: true }; }
  } });
  const first = f.fs.write("/owned/a", "\0".repeat(300000)).catch(error => error);
  await started;
  const second = f.fs.mkdir("/owned/queued").catch(error => error);
  controller.abort();
  expect(await second).toBeInstanceOf(Error);
  expect(released).toBe(false);
  finish();
  expect(await first).toBeInstanceOf(Error);
  expect(released).toBe(true);
  expect(f.calls.some(c => c.method === "capability.fs.mkdir")).toBe(false);
});
test("unrelated cleanup failure is not hidden and the next transaction can proceed", async () => {
  const f = fixture({ override: method => {
    if (method.endsWith(".writeChunk")) throw Error("stage failed");
    if (method.endsWith(".releaseWrite")) throw Error("cleanup failed");
  } });
  await expect(f.fs.write("/owned/a", "\0".repeat(300000))).rejects.toThrow("cleanup failed");
  await f.fs.mkdir("/owned/next");
  expect(f.calls.at(-1)!.method).toBe("capability.fs.mkdir");
});


test("mkdir waits for the entire preceding write transaction", async () => {
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const barrier = new Promise<void>(resolve => { finish = resolve; });
  let held = false;
  const f = fixture({ override: async method => {
    if (method.endsWith(".writeChunk") && !held) { held = true; entered(); await barrier; }
  } });
  const first = f.fs.write("/owned/a", "\0".repeat(300000));
  await started;
  const second = f.fs.mkdir("/owned/next");
  await Bun.sleep(0);
  expect(f.calls.some(c => c.method === "capability.fs.mkdir")).toBe(false);
  finish();
  await Promise.all([first, second]);
  expect(f.calls.slice(-2).map(c => c.method)).toEqual(["capability.fs.commitWrite", "capability.fs.mkdir"]);
});
test("admitted inline calls cannot report success after owner abort", async () => {
  const controller = new AbortController();
  const f = fixture({ signal: controller.signal, override: () => { controller.abort(); return { ok: true }; } });
  await expect(f.fs.write("/owned/a", "x")).rejects.toThrow("owning plugin call ended");
});
test("failed consumed commit still attempts owned release and preserves unrelated cleanup failure", async () => {
  const f = fixture({ override: method => {
    if (method.endsWith(".commitWrite")) throw Error("commit failed");
    if (method.endsWith(".releaseWrite")) return { ok: true };
  } });
  await expect(f.fs.write("/owned/a", "\0".repeat(300000))).rejects.toThrow("commit failed");
  expect(f.calls.at(-1)!.method).toBe("capability.fs.releaseWrite");
});
