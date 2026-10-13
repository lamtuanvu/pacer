import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { writeRelease } from "../scripts/release/build";
import { main } from "../src/cli";
import { releaseFetch } from "../src/update/fetch";
import { type Platform, assetFile, hostPlatform } from "../src/update/manifest";
import { type UpdateDeps, defaultUpdateDeps, parseUpdateArgs, runUpdate } from "../src/update/update";
import { currentVersion } from "../src/update/version";
import { fakeCtx, tmpDir } from "./helpers";

const MAC: Platform = { os: "darwin", arch: "arm64" };
const script = (v: string) => `#!/bin/sh\necho "pacer ${v}"\n`;
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

function release(root: string, version: string, platforms: Platform[] = [MAC], body: (v: string) => string = script): void {
  const dir = join(root, version);
  mkdirSync(dir, { recursive: true });
  for (const p of platforms) {
    const f = join(dir, assetFile(p));
    writeFileSync(f, body(version));
    chmodSync(f, 0o755);
  }
  writeRelease(root, version, platforms);
}

function installed(version = "0.1.0"): string {
  const bin = join(tmpDir(), "bin");
  mkdirSync(bin);
  const p = join(bin, "pacer");
  writeFileSync(p, script(version));
  chmodSync(p, 0o755);
  return p;
}

function deps(root: string, execPath: string, o: Partial<UpdateDeps> = {}): UpdateDeps {
  return { env: { PACER_RELEASE_BASE: pathToFileURL(root).href }, fetch: releaseFetch, execPath, standalone: true, version: "0.1.0", platform: MAC, ...o };
}

test("--check reports an available update and changes nothing", async () => {
  const root = tmpDir();
  release(root, "0.1.0");
  release(root, "0.2.0");
  const exec = installed();
  expect(await runUpdate({ check: true }, deps(root, exec))).toEqual({ code: 0, out: "update available: 0.1.0 -> 0.2.0\nrun: pacer update", err: "" });
  expect(readFileSync(exec, "utf8")).toBe(script("0.1.0"));
  expect(existsSync(`${exec}.bak`)).toBe(false);
});

test("already on the latest release: nothing is downloaded", async () => {
  const root = tmpDir();
  release(root, "0.1.0");
  const exec = installed();
  expect(await runUpdate({ check: false }, deps(root, exec))).toEqual({ code: 0, out: "pacer 0.1.0 is up to date", err: "" });
  expect(await runUpdate({ check: true }, deps(root, exec, { version: "0.3.0" }))).toEqual({ code: 0, out: "pacer 0.3.0 is up to date (latest release: 0.1.0)", err: "" });
  expect(readdirSync(dirname(exec))).toEqual(["pacer"]);
});

test("update replaces the binary, keeps a .bak and leaves no temp files", async () => {
  const root = tmpDir();
  release(root, "0.2.0");
  const exec = installed();
  const r = await runUpdate({ check: false }, deps(root, exec));
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  expect(r.out).toContain("updated pacer 0.1.0 -> 0.2.0");
  expect(r.out).toContain("previous binary: ");
  expect(readFileSync(exec, "utf8")).toBe(script("0.2.0"));
  expect(readFileSync(`${exec}.bak`, "utf8")).toBe(script("0.1.0"));
  expect(readdirSync(dirname(exec)).sort()).toEqual(["pacer", "pacer.bak"]);
});

test("works over loopback http, and --base overrides PACER_RELEASE_BASE", async () => {
  const root = tmpDir();
  release(root, "0.2.0");
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const f = Bun.file(join(root, decodeURIComponent(new URL(req.url).pathname)));
      return (await f.exists()) ? new Response(f) : new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  const exec = installed();
  const d = deps(root, exec, { env: { PACER_RELEASE_BASE: "file:///nonexistent/release" } });
  const r = await runUpdate({ check: false, base: String(server.url) }, d);
  expect(r.code).toBe(0);
  expect(readFileSync(exec, "utf8")).toBe(script("0.2.0"));
});

test("--to installs a specific version, including a downgrade; an unknown version fails cleanly", async () => {
  const root = tmpDir();
  release(root, "0.1.0");
  release(root, "0.2.0");
  const exec = installed("0.2.0");
  const down = await runUpdate({ check: false, to: "0.1.0" }, deps(root, exec, { version: "0.2.0" }));
  expect(down.code).toBe(0);
  expect(down.out).toContain("updated pacer 0.2.0 -> 0.1.0");
  expect(readFileSync(exec, "utf8")).toBe(script("0.1.0"));
  const same = await runUpdate({ check: false, to: "0.1.0" }, deps(root, exec, { version: "0.1.0" }));
  expect(same).toEqual({ code: 0, out: "pacer 0.1.0 is already installed", err: "" });
  const older = await runUpdate({ check: true, to: "0.1.0" }, deps(root, exec, { version: "0.2.0" }));
  expect(older.out).toBe("0.1.0 is older than the installed 0.2.0; run pacer update --to 0.1.0 to downgrade");
  const missing = await runUpdate({ check: false, to: "9.9.9" }, deps(root, exec, { version: "0.1.0" }));
  expect(missing.code).toBe(1);
  expect(missing.err).toContain("9.9.9/manifest.json (HTTP 404)");
  expect(readFileSync(exec, "utf8")).toBe(script("0.1.0"));
});

test("a tampered download is refused and nothing changes", async () => {
  const root = tmpDir();
  release(root, "0.2.0");
  writeFileSync(join(root, "0.2.0", "pacer-darwin-arm64"), `${script("0.2.0")}# evil\n`);
  const exec = installed();
  const r = await runUpdate({ check: false }, deps(root, exec));
  expect(r.code).toBe(1);
  expect(r.err).toContain("exceeds ");
  expect(readFileSync(exec, "utf8")).toBe(script("0.1.0"));
  expect(readdirSync(dirname(exec))).toEqual(["pacer"]);
});

test("a same-length tampered download fails the checksum and nothing changes", async () => {
  const root = tmpDir();
  release(root, "0.2.0");
  const file = join(root, "0.2.0", "pacer-darwin-arm64");
  const good = readFileSync(file, "utf8");
  writeFileSync(file, good.replace("0.2.0", "0.2.1"));
  const exec = installed();
  const r = await runUpdate({ check: false }, deps(root, exec));
  expect(r.code).toBe(1);
  expect(r.err).toContain("checksum mismatch");
  expect(readFileSync(exec, "utf8")).toBe(script("0.1.0"));
  expect(readdirSync(dirname(exec))).toEqual(["pacer"]);
});

test("SHA256SUMS disagreeing with manifest.json is refused", async () => {
  const root = tmpDir();
  release(root, "0.2.0");
  writeFileSync(join(root, "0.2.0", "SHA256SUMS"), `${"0".repeat(64)}  pacer-darwin-arm64\n`);
  const exec = installed();
  const r = await runUpdate({ check: false }, deps(root, exec));
  expect(r.code).toBe(1);
  expect(r.err).toContain("SHA256SUMS and manifest.json disagree about pacer-darwin-arm64");
  expect(readFileSync(exec, "utf8")).toBe(script("0.1.0"));
});

test("a binary that does not run is refused", async () => {
  const root = tmpDir();
  release(root, "0.2.0", [MAC], () => "#!/bin/sh\nexit 1\n");
  const exec = installed();
  const r = await runUpdate({ check: false }, deps(root, exec));
  expect(r.code).toBe(1);
  expect(r.err).toContain("did not report version 0.2.0");
  expect(readFileSync(exec, "utf8")).toBe(script("0.1.0"));
  expect(readdirSync(dirname(exec))).toEqual(["pacer"]);
});

test("refuses to replace a source checkout, but --check still works", async () => {
  const root = tmpDir();
  release(root, "0.2.0");
  const exec = installed();
  const r = await runUpdate({ check: false }, deps(root, exec, { standalone: false }));
  expect(r.code).toBe(2);
  expect(r.err).toContain("runs from source (bun src/cli.ts)");
  expect(readFileSync(exec, "utf8")).toBe(script("0.1.0"));
  expect((await runUpdate({ check: true }, deps(root, exec, { standalone: false }))).out).toContain("update available: 0.1.0 -> 0.2.0");
});

test("defaults to GitHub and refuses an insecure explicit base", async () => {
  const exec = installed();
  const urls: string[] = [];
  const none = await runUpdate({ check: true }, deps(tmpDir(), exec, { env: {}, fetch: async url => {
    urls.push(url);
    return new Response(JSON.stringify({ version: "0.1.0" }));
  } }));
  expect(none.code).toBe(0);
  expect(urls).toEqual(["https://github.com/lamtuanvu/pacer/releases/latest/download/latest.json"]);
  const http = await runUpdate({ check: false }, deps(tmpDir(), exec, { env: { PACER_RELEASE_BASE: "http://example.com/r" } }));
  expect(http.code).toBe(2);
  expect(http.err).toContain("must start with https://");
});

test("unsupported platform, missing platform build and a bad latest.json", async () => {
  const exec = installed();
  const root = tmpDir();
  release(root, "0.2.0", [{ os: "linux", arch: "x64" }]);
  expect((await runUpdate({ check: false }, deps(root, exec, { platform: null }))).code).toBe(2);
  const noBuild = await runUpdate({ check: false }, deps(root, exec));
  expect(noBuild.code).toBe(1);
  expect(noBuild.err).toContain("release 0.2.0 has no build for darwin-arm64");
  writeFileSync(join(root, "latest.json"), JSON.stringify({ version: "../../etc" }));
  const bad = await runUpdate({ check: false }, deps(root, exec));
  expect(bad.code).toBe(1);
  expect(bad.err).toContain("latest.json has no valid");
  writeFileSync(join(root, "latest.json"), "{oops");
  expect((await runUpdate({ check: false }, deps(root, exec))).err).toContain("not valid JSON");
});

test("parseUpdateArgs", () => {
  expect(parseUpdateArgs([])).toEqual({ check: false });
  expect(parseUpdateArgs(["--check", "--to", "v0.2.0", "--base", "file:///x"])).toEqual({ check: true, to: "0.2.0", base: "file:///x" });
  expect(parseUpdateArgs(["--to"])).toContain("--to needs a value");
  expect(parseUpdateArgs(["--to", "latest"])).toContain('invalid version "latest"');
  expect(parseUpdateArgs(["--force"])).toContain('unknown argument "--force"');
});

test("defaultUpdateDeps describes the running process", () => {
  const d = defaultUpdateDeps(fakeCtx({ env: { PACER_RELEASE_BASE: "file:///r" } }));
  expect(d.env.PACER_RELEASE_BASE).toBe("file:///r");
  expect(d.standalone).toBe(false);
  expect(d.execPath).toBe(process.execPath);
  expect(d.version).toBe(currentVersion());
  expect(d.platform).toEqual(hostPlatform());
});

test("pacer update through the CLI refuses from source and validates arguments", async () => {
  const root = tmpDir();
  release(root, "99.0.0", [hostPlatform() ?? MAC]);
  const ctx = fakeCtx({ env: { PACER_RELEASE_BASE: pathToFileURL(root).href } });
  const r = await main(["update"], ctx);
  expect(r.code).toBe(2);
  expect(r.err).toContain("runs from source");
  expect((await main(["update", "--force"], ctx)).code).toBe(2);
  expect((await main(["update", "--check"], ctx)).out).toContain(`-> 99.0.0`);
  expect((await main(["help"], ctx)).out).toContain("update [--check] [--to <v>] [--base <url>]");
});

test("update restarts after successful replacement, warns on restart failure, and honors --no-restart", async () => {
  expect(parseUpdateArgs(["--no-restart"])).toEqual({ check: false, noRestart: true });
  for (const mode of ["success", "failure", "skip", "check", "not-installed"]) {
    const root = tmpDir(); release(root, "0.2.0"); const exec = installed(); let calls = 0;
    const r = await runUpdate({ check: mode === "check", noRestart: mode === "skip" }, deps(root, exec, { restartService: async path => {
      calls++; expect(path).toBe(realpathSync(exec)); expect(readFileSync(exec, "utf8")).toBe(script("0.2.0"));
      if (mode === "failure") throw Error("kickstart failed"); return mode !== "not-installed";
    } }));
    expect(r.code).toBe(0); expect(calls).toBe(mode === "skip" || mode === "check" ? 0 : 1);
    if (mode === "success") expect(r.out).toContain("restarted pacer serve");
    if (mode === "failure") expect(r.out).toContain("WARNING: could not restart pacer serve: kickstart failed");
    if (mode === "skip" || mode === "not-installed") expect(r.out).not.toContain("restarted pacer serve");
  }
});

test("update reports service and console restart counts and retains warning with counts", async()=>{
 for(const warning of [undefined,"could not restart pacer serve: unavailable"]) {
  const root=tmpDir();release(root,"0.2.0");const exec=installed();
  const result=await runUpdate({check:false},deps(root,exec,{restartService:async()=>({restarted:!warning,consoles:2,warning})}));
  expect(result.code).toBe(0);expect(result.out).toContain("restarted 2 pacer consoles");if(warning)expect(result.out).toContain(`WARNING: ${warning}`);else expect(result.out).toContain("restarted pacer serve");
 }
});
