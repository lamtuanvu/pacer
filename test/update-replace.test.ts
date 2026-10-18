import { afterEach, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ReleaseError } from "../src/update/errors";
import { fetchBytes, fetchText, normalizeBase, releaseFetch } from "../src/update/fetch";
import { replaceBinary, reportsVersion, runVersion } from "../src/update/replace";
import { tmpDir } from "./helpers";

const script = (v: string) => `#!/bin/sh\necho "pacer ${v}"\n`;
const enc = (s: string) => new TextEncoder().encode(s);
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

function installed(dir: string, v = "0.1.0"): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "pacer");
  writeFileSync(p, script(v));
  chmodSync(p, 0o755);
  return p;
}

test("normalizeBase trims slashes and allows only https, file and loopback http", () => {
  expect(normalizeBase("file:///srv/release///")).toBe("file:///srv/release");
  expect(normalizeBase("https://example.com/pacer/")).toBe("https://example.com/pacer");
  expect(normalizeBase("http://127.0.0.1:4321")).toBe("http://127.0.0.1:4321");
  expect(normalizeBase("http://localhost/r")).toBe("http://localhost/r");
  for (const bad of ["http://example.com/r", "ftp://x/y", "/abs/path", "http://127.0.0.1.evil.com/x", "http://127.0.0.1:1@evil.com/", "https://example.com/r?x=1", "file:///tmp/release#frag"]) {
    expect(() => normalizeBase(bad)).toThrow("must start with https://");
  }
});

test("download limits use Content-Length and stop streaming after the byte cap", async () => {
  const declared = await fetchBytes(async () => new Response("12345", { headers: { "content-length": "5" } }), "fixture://declared", 4).catch((e: unknown) => e);
  expect((declared as Error).message).toContain("exceeds 4 byte limit");
  let pulled = 0;
  let cancelled = false;
  const streaming = new ReadableStream<Uint8Array>({
    pull(controller) { pulled++; controller.enqueue(new Uint8Array(3)); },
    cancel() { cancelled = true; },
  });
  const oversized = await fetchBytes(async () => new Response(streaming), "fixture://stream", 4).catch((e: unknown) => e);
  expect((oversized as Error).message).toContain("exceeds 4 byte limit");
  expect(pulled).toBeLessThanOrEqual(3);
  expect(cancelled).toBe(true);
  const metadata = await fetchText(async () => new Response("x".repeat(1024 * 1024 + 1)), "fixture://metadata").catch((e: unknown) => e);
  expect((metadata as Error).message).toContain("exceeds 1048576 byte limit");
});

test("releaseFetch reads file:// URLs and reports a missing file as HTTP 404", async () => {
  const dir = tmpDir();
  writeFileSync(join(dir, "a.txt"), "hello");
  expect(await fetchText(releaseFetch, pathToFileURL(join(dir, "a.txt")).href)).toBe("hello");
  const err = await fetchBytes(releaseFetch, pathToFileURL(join(dir, "missing")).href).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ReleaseError);
  expect((err as Error).message).toContain("(HTTP 404)");
});

test("releaseFetch downloads over loopback http; refused connections are download failures", async () => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => (new URL(req.url).pathname === "/x.bin" ? new Response(new Uint8Array([1, 2, 3])) : new Response("no", { status: 404 })),
  });
  servers.push(server);
  const base = String(server.url).replace(/\/$/, "");
  expect([...(await fetchBytes(releaseFetch, `${base}/x.bin`))]).toEqual([1, 2, 3]);
  expect(((await fetchBytes(releaseFetch, `${base}/nope`).catch((e: unknown) => e)) as Error).message).toContain("(HTTP 404)");
  const dead = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const deadUrl = `${String(dead.url).replace(/\/$/, "")}/x`;
  dead.stop(true);
  const err = await fetchBytes(releaseFetch, deadUrl).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ReleaseError);
  expect((err as Error).message).toContain(`download failed: ${deadUrl}`);
});

test("releaseFetch refuses redirects without requesting their target", async () => {
  let targetRequests = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      if (new URL(req.url).pathname === "/start") return new Response(null, { status: 302, headers: { Location: "http://example.com/x" } });
      targetRequests++;
      return new Response("unexpected");
    },
  });
  servers.push(server);
  const url = `${String(server.url).replace(/\/$/, "")}/start`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "http://example.com/x") targetRequests++;
    return originalFetch(input, init);
  }) as typeof fetch;
  try {
    const err = await fetchBytes(releaseFetch, url).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReleaseError);
    expect((err as Error).message).toContain(url);
    expect((err as Error).message).toContain("redirect");
    expect(targetRequests).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runVersion and reportsVersion", async () => {
  const p = installed(tmpDir(), "0.2.0");
  expect((await runVersion(p)).trim()).toBe("pacer 0.2.0");
  expect(await runVersion(join(tmpDir(), "missing"))).toBe("");
  expect(reportsVersion("pacer 0.2.0\n", "0.2.0")).toBe(true);
  expect(reportsVersion("pacer 0.2.0-rc.1", "0.2.0")).toBe(false);
  expect(reportsVersion("", "0.2.0")).toBe(false);
});

test("runVersion rejects a version-printing process that exits nonzero", async () => {
  const p = installed(tmpDir());
  writeFileSync(p, `${script("0.2.0")}exit 1\n`);
  chmodSync(p, 0o755);
  expect(await runVersion(p)).toBe("");
});

test("replaceBinary swaps the binary atomically and keeps the old one as .bak", async () => {
  const dir = join(tmpDir(), "bin");
  const p = installed(dir, "0.1.0");
  writeFileSync(`${p}.bak`, "an older backup");
  const r = await replaceBinary(p, enc(script("0.2.0")), "0.2.0");
  expect(r).toEqual({ path: realpathSync(p), backup: `${realpathSync(p)}.bak` });
  expect(readFileSync(p, "utf8")).toBe(script("0.2.0"));
  expect(readFileSync(`${p}.bak`, "utf8")).toBe(script("0.1.0"));
  expect(statSync(p).mode & 0o777).toBe(0o755);
  expect(readdirSync(dir).sort()).toEqual(["pacer", "pacer.bak"]);
});

test("replaceBinary follows a symlink and replaces the real file", async () => {
  const root = tmpDir();
  const real = installed(join(root, "opt"), "0.1.0");
  mkdirSync(join(root, "bin"));
  const link = join(root, "bin", "pacer");
  symlinkSync(real, link);
  const r = await replaceBinary(link, enc(script("0.2.0")), "0.2.0");
  expect(r.path).toBe(realpathSync(real));
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(readFileSync(real, "utf8")).toBe(script("0.2.0"));
  expect(readFileSync(`${real}.bak`, "utf8")).toBe(script("0.1.0"));
});

test("a binary that reports the wrong version is not installed", async () => {
  const dir = join(tmpDir(), "bin");
  const p = installed(dir, "0.1.0");
  const err = await replaceBinary(p, enc(script("0.0.9")), "0.2.0").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ReleaseError);
  expect((err as Error).message).toContain("did not report version 0.2.0");
  expect(readFileSync(p, "utf8")).toBe(script("0.1.0"));
  expect(readdirSync(dir)).toEqual(["pacer"]);
});

test("replacement wraps non-permission filesystem failures in ReleaseError", async () => {
  const dir = join(tmpDir(), "bin");
  const p = installed(dir, "0.1.0");
  const smoke = async () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); };
  const err = await replaceBinary(p, enc(script("0.2.0")), "0.2.0", smoke).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ReleaseError);
  expect((err as Error).message).toContain(`could not replace ${realpathSync(p)}: disk full`);
});

test("failed replacement keeps the previous backup intact", async () => {
  const dir = join(tmpDir(), "bin");
  const p = installed(dir, "0.1.0");
  writeFileSync(`${p}.bak`, "existing backup");
  const err = await replaceBinary(p, enc(script("0.2.0")), "0.2.0", async () => "wrong version").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ReleaseError);
  expect(readFileSync(`${p}.bak`, "utf8")).toBe("existing backup");
});

test.skipIf(process.getuid?.() === 0)("an unwritable directory fails cleanly", async () => {
  const dir = join(tmpDir(), "bin");
  const p = installed(dir, "0.1.0");
  chmodSync(dir, 0o555);
  try {
    const err = await replaceBinary(p, enc(script("0.2.0")), "0.2.0").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReleaseError);
    expect((err as Error).message).toContain(`cannot write to ${realpathSync(dir)}`);
  } finally {
    chmodSync(dir, 0o755);
  }
  expect(readFileSync(p, "utf8")).toBe(script("0.1.0"));
  expect(readdirSync(dir)).toEqual(["pacer"]);
});

test("download follows HTTPS redirects across hosts and resolves relative locations", async () => {
  const seen: string[] = [];
  const download = async (url: string) => {
    seen.push(url);
    if (url === "https://github.com/start") return new Response(null, { status: 302, headers: { location: "https://assets.example/path/file" } });
    if (url === "https://assets.example/path/file") return new Response(null, { status: 307, headers: { location: "../binary?token=1" } });
    return new Response("binary");
  };
  expect(await fetchText(download, "https://github.com/start")).toBe("binary");
  expect(seen).toEqual(["https://github.com/start", "https://assets.example/path/file", "https://assets.example/binary?token=1"]);
});

test("download rejects non-HTTPS and credentialed redirects before fetching the next hop", async () => {
  for (const location of ["http://example.com/file", "file:///tmp/file", "ftp://example.com/file", "https://user:password@example.com/file"]) {
    let calls = 0;
    await expect(fetchBytes(async () => { calls++; return new Response(null, { status: 301, headers: { location } }); }, "https://example.com/start")).rejects.toThrow("redirect must target https://");
    expect(calls).toBe(1);
  }
});

test("download allows five redirects, rejects a sixth and rejects missing Location", async () => {
  let calls = 0;
  const download = async () => { calls++; return calls <= 5 ? new Response(null, { status: 308, headers: { location: "/next" } }) : new Response("done"); };
  expect(await fetchText(download, "https://example.com/start")).toBe("done");
  expect(calls).toBe(6);
  calls = 0;
  await expect(fetchText(async () => { calls++; return new Response(null, { status: 302, headers: { location: "/loop" } }); }, "https://example.com/start")).rejects.toThrow("redirect limit (5) exceeded");
  expect(calls).toBe(6);
  await expect(fetchText(async () => new Response(null, { status: 302 }), "https://example.com/start")).rejects.toThrow("has no Location");
});

test("signs only the staged inode before smoke and preserves target on signing failure", async () => {
  const dir = tmpDir(), target = installed(dir), originalInode = statSync(target).ino;
  let staged = "";
  await replaceBinary(target, enc(script("0.2.0")), "0.2.0", async path => {
    expect(path).toBe(staged);
    expect(statSync(target).ino).toBe(originalInode);
    return "pacer 0.2.0";
  }, async path => {
    staged = path;
    expect(path).not.toBe(target);
    expect(statSync(path).ino).not.toBe(originalInode);
    expect(readFileSync(target, "utf8")).toBe(script("0.1.0"));
  });
  expect(readFileSync(target, "utf8")).toBe(script("0.2.0"));
  await expect(replaceBinary(target, enc(script("0.3.0")), "0.3.0", async () => { throw Error("must not smoke"); }, async () => { throw Error("signing failed"); })).rejects.toThrow("signing failed");
  expect(readFileSync(target, "utf8")).toBe(script("0.2.0"));
  expect(readdirSync(dir).some(p => p.includes(".update-"))).toBe(false);
});
