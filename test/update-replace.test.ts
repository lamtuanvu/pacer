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
  for (const bad of ["http://example.com/r", "ftp://x/y", "/abs/path", "http://127.0.0.1.evil.com/x", "http://127.0.0.1:1@evil.com/"]) {
    expect(() => normalizeBase(bad)).toThrow("must start with https://");
  }
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

test("runVersion and reportsVersion", async () => {
  const p = installed(tmpDir(), "0.2.0");
  expect((await runVersion(p)).trim()).toBe("pacer 0.2.0");
  expect(await runVersion(join(tmpDir(), "missing"))).toBe("");
  expect(reportsVersion("pacer 0.2.0\n", "0.2.0")).toBe(true);
  expect(reportsVersion("pacer 0.2.0-rc.1", "0.2.0")).toBe(false);
  expect(reportsVersion("", "0.2.0")).toBe(false);
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
