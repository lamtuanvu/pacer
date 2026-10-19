import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { writeRelease } from "../scripts/release/build";
import { main } from "../src/cli";
import { callOp } from "../src/api/ops";
import { listJobs } from "../src/jobs/registry";
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

test("dev builds never download or offer equal or older releases", async () => {
  const root = tmpDir();
  const exec = installed();
  for (const latest of ["0.2.2", "0.2.3"]) {
    writeFileSync(join(root, "latest.json"), JSON.stringify({ version: latest }));
    for (const check of [true, false]) {
      const result = await runUpdate({ check }, deps(root, exec, { version: "0.2.3+12.gabc1234" }));
      expect(result.code).toBe(0);
      expect(result.out).toContain("is up to date");
      expect(result.out).not.toContain("update available");
      expect(readdirSync(dirname(exec))).toEqual(["pacer"]);
    }
  }
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
  expect(same.code).toBe(0);
  expect(same.out).toContain("updated pacer 0.1.0 -> 0.1.0");
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
  expect((await main(["help"], ctx)).out).toContain("update [--check [--json]] [--to <v>] [--base <url>]");
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

test("update reports service restart and retains its warning", async()=>{
 for(const warning of [undefined,"could not restart pacer serve: unavailable"]) {
  const root=tmpDir();release(root,"0.2.0");const exec=installed();
  const result=await runUpdate({check:false},deps(root,exec,{restartService:async()=>({restarted:!warning,warning})}));
  expect(result.code).toBe(0);expect(result.out).not.toContain("pacer consoles");if(warning)expect(result.out).toContain(`WARNING: ${warning}`);else expect(result.out).toContain("restarted pacer serve");
 }
});


test("npm installations refuse replacement and --check reports the package-manager hint", async () => {
  const root = tmpDir(); release(root, "0.2.0"); const exec = installed();
  const d = deps(root, exec, { env: { PACER_INSTALL_METHOD: "npm", PACER_RELEASE_BASE: pathToFileURL(root).href } });
  const hint = "pacer was installed with npm; update with: npm install -g @lamtuanvu/pacer@latest";
  expect(await runUpdate({ check: false }, { ...d, fetch: async () => { throw Error("must not fetch"); } })).toEqual({ code: 2, out: "", err: `pacer update: ${hint}` });
  expect(await runUpdate({ check: true }, d)).toEqual({ code: 0, out: `update available: 0.1.0 -> 0.2.0\n${hint}`, err: "" });
  expect((await runUpdate({ check: true }, { ...d, version: "0.2.0" })).out).toBe(`pacer 0.2.0 is up to date\n${hint}`);
  expect(readFileSync(exec, "utf8")).toBe(script("0.1.0"));
});

test("Homebrew detection follows executable symlinks and honors configured prefixes", async () => {
  const root = tmpDir(); release(root, "0.2.0");
  for (const mode of ["cellar", "prefix", "custom-cellar"]) {
    const installRoot = tmpDir();
    const real = join(installRoot, mode === "cellar" ? "Cellar/pacer/0.1.0/bin/pacer" : "custom/bin/pacer");
    mkdirSync(dirname(real), { recursive: true }); writeFileSync(real, script("0.1.0"));
    const exec = join(tmpDir(), "pacer"); symlinkSync(real, exec);
    const env: Record<string, string> = { PACER_RELEASE_BASE: pathToFileURL(root).href };
    if (mode === "prefix") env.HOMEBREW_PREFIX = join(installRoot, "custom");
    if (mode === "custom-cellar") env.HOMEBREW_CELLAR = join(installRoot, "custom") + "/";
    const d = deps(root, exec, { env });
    const hint = "pacer was installed with Homebrew; update with: brew upgrade pacer";
    expect(await runUpdate({ check: false }, d)).toEqual({ code: 2, out: "", err: `pacer update: ${hint}` });
    expect(await runUpdate({ check: true }, d)).toEqual({ code: 0, out: `update available: 0.1.0 -> 0.2.0\n${hint}`, err: "" });
    expect(readFileSync(real, "utf8")).toBe(script("0.1.0"));
  }
});

test("a sibling of a Homebrew prefix keeps the default update behavior", async () => {
  const root = tmpDir(); release(root, "0.2.0"); const exec = installed();
  const d = deps(root, exec, { env: { PACER_RELEASE_BASE: pathToFileURL(root).href, HOMEBREW_PREFIX: dirname(exec) + "-other" } });
  expect((await runUpdate({ check: false }, d)).code).toBe(0);
  expect(readFileSync(exec, "utf8")).toBe(script("0.2.0"));
});

test("update refreshes only after replacement and --to forces same-version refresh", async () => {
  expect(parseUpdateArgs(["--no-reinstall"])).toEqual({ check: false, noReinstall: true });
  for (const mode of ["update", "check", "unchanged", "forced", "skip", "failure", "tampered"]) {
    const root = tmpDir();
    const target = mode === "unchanged" || mode === "forced" ? "0.1.0" : "0.2.0";
    release(root, target);
    if (mode === "tampered") writeFileSync(join(root, target, assetFile(MAC)), "bad download");
    const exec = installed(); let calls = 0;
    const result = await runUpdate({ check: mode === "check", to: mode === "forced" ? target : undefined, noReinstall: mode === "skip", noRestart: true }, deps(root, exec, {
      refreshIntegrations: async path => {
        calls++; expect(path).toBe(realpathSync(exec));
        expect(readFileSync(path, "utf8")).toBe(script(target));
        if (mode === "failure") throw Error("broken manifest");
        return ["claude-code: refreshed", "codex: unchanged", "WARNING: cursor: failed: bad config"];
      },
    }));
    const refreshed = ["update", "forced", "failure"].includes(mode);
    expect(calls).toBe(refreshed ? 1 : 0);
    expect(result.code).toBe(mode === "tampered" ? 1 : 0);
    if (mode === "failure") expect(result.out).toContain("WARNING: could not refresh integrations: broken manifest");
    else if (refreshed) expect(result.out).toContain("claude-code: refreshed\ncodex: unchanged\nWARNING: cursor: failed: bad config");
    else expect(result.out).not.toContain("refreshed");
  }
});


test("update refreshes the installed plugin after replacement, skips it with --no-reinstall and tolerates failure", async () => {
  const { refreshIntegrations } = await import("../src/commands/update-refresh");
  const { installPlugin, pluginDir } = await import("../src/plugin/install");
  for (const mode of ["refresh", "skip", "failure"]) {
    const root = tmpDir(); release(root, "0.2.0"); const exec = installed();
    const calls: string[][] = [];
    const ctx = fakeCtx({ run: async argv => {
      calls.push(argv);
      expect(argv).toEqual([realpathSync(exec), "plugin", "install"]);
      expect(readFileSync(argv[0]!, "utf8")).toBe(script("0.2.0"));
      if (mode === "failure") return { code: 1, stdout: "", stderr: "plugin failed\nmore" };
      return { code: 0, stdout: (await installPlugin({ ctx, pacerArgv: [argv[0]!] })).text, stderr: "" };
    } });
    await installPlugin({ ctx, pacerArgv: ["old-pacer"] });
    const file = join(pluginDir(ctx), "orca-plugin.json");
    const original = readFileSync(file, "utf8"); writeFileSync(file, "old plugin");
    const result = await runUpdate({ check: false, noRestart: true, noReinstall: mode === "skip" }, deps(root, exec, { refreshIntegrations: path => refreshIntegrations(ctx, path) }));
    expect(result.code).toBe(0);
    expect(calls.length).toBe(mode === "skip" ? 0 : 1);
    expect(readFileSync(file, "utf8")).toBe(mode === "refresh" ? original : "old plugin");
    if (mode === "refresh") expect(result.out).toContain("orca-plugin: refreshed (turn pacer off and on in Orca Settings > Plugins to load it)");
    else if (mode === "failure") expect(result.out).toContain("WARNING: orca-plugin: failed: plugin failed");
    else expect(result.out).not.toContain("orca-plugin:");
  }
});

test('update progress follows download, verification, replacement, refresh and restart',async()=>{
 const root=tmpDir();release(root,'0.2.0');const exec=installed();
 const events:unknown[]=[];
 const result=await runUpdate({check:false},deps(root,exec,{progress:(...args)=>events.push(args),refreshIntegrations:async()=>[],restartService:async()=>true}));
 expect(result.code).toBe(0);
 expect(events).toEqual([
  ['Download','running'],['Download','passed'],['Verify','running'],['Verify','passed'],['Replace','running'],['Replace','passed'],['Refresh integrations','running'],['Refresh integrations','passed'],['Restart','running','0.2.0']
 ]);
});

test("bundled CLI refuses direct and symlink self-updates before any side effect without install env", async () => {
  const root = tmpDir(); release(root, "0.1.0");
  const bundled = join(tmpDir(), "pacer.app/Contents/Resources/pacer");
  mkdirSync(dirname(bundled), { recursive: true }); writeFileSync(bundled, script("0.1.0"));
  const alias = join(tmpDir(), "pacer"); symlinkSync(bundled, alias);
  for (const exec of [bundled, alias]) {
    const calls: string[] = [];
    const d = deps(root, exec, {
      env: {}, fetch: async () => { calls.push("download"); throw Error("must not download"); },
      migrateStrategy: () => { calls.push("strategy"); return []; },
      refreshIntegrations: async () => { calls.push("integrations"); return []; },
      restartService: async () => { calls.push("restart"); return true; },
    });
    const result = await runUpdate({ check: false }, d);
    expect(result.code).toBe(2); expect(result.err).toContain("desktop"); expect(calls).toEqual([]);
    expect(readFileSync(bundled, "utf8")).toBe(script("0.1.0"));
    const checked = await runUpdate({ check: true }, deps(root, exec));
    expect(checked.code).toBe(0); expect(checked.out).toContain("desktop");
  }
});


test("update.apply refuses a bundled executable before creating a shared update job", async () => {
  const ctx = fakeCtx(), bundled = join(tmpDir(), "pacer.app/Contents/Resources/pacer");
  mkdirSync(dirname(bundled), { recursive: true }); writeFileSync(bundled, script("0.1.0"));
  let calls = 0;
  await expect(callOp(ctx, "update.apply", {}, {
    update: { standalone: true, execPath: bundled },
    runUpdate: async () => { calls++; return { code: 0, out: "", err: "" }; },
  })).rejects.toMatchObject({ code: "not_allowed", message: expect.stringContaining("desktop") });
  expect(calls).toBe(0);
  expect(listJobs(ctx)).toHaveLength(0);
});
