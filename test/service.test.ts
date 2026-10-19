import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { main } from "../src/cli";
import { readManifest } from "../src/install/manifest";
import { runDoctor } from "../src/install/doctor";
import { health, binaryInFile, parseLaunchd, parseSystemd, plist, restartAfterUpdate, serviceBackend, serviceInstalled, servicePath, servicePATH, unit, type ServiceDeps } from "../src/service";
import { serviceCli } from "../src/service/cli";
import { fakeCtx } from "./helpers";
const goodFetch = (async () => Response.json({ ok: true, pid:456 }, { headers: { "X-Pacer": "1" } })) as NonNullable<ServiceDeps["fetch"]>;
const deps: ServiceDeps = { platform: "darwin", uid: 501, argv: ["/opt/pacer"], fetch: goodFetch, waitMs: 0 };
function put(path: string, text: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
function fixture(platform = "darwin") {
  const calls: string[][] = [];
  const ctx = fakeCtx({ env: { PATH: "/bin:/usr/bin:/bin", PACER_BIN: "/opt/pacer" }, which: b => ["orca", "bun"].includes(b) ? `/opt/tools/${b}` : null,
    run: async argv => { calls.push(argv); return { code: 0, stdout: platform === "darwin" ? "service = {\n state = running\n pid = 456\n last exit code = 9\n}\n" : "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=456\nExecMainStatus=9\n", stderr: "" }; } });
  return { ctx, calls, d: { ...deps, platform }, path: servicePath(ctx, platform) };
}
test("plist escapes XML and assembles deterministic argv, home, paths and launchd policy", () => {
  const ctx = fakeCtx({ home: '/tmp/a&b<"\'>', pacerHome: "/tmp/p&x", env: { PATH: "/bin:/bin:/usr/bin" }, which: b => b === "bun" ? "/tools/bun" : null });
  const text = plist(ctx, ["/tools/bun", '/repo/a&b<"\'>.ts']);
  expect(text).toContain("a&amp;b&lt;&quot;&apos;&gt;");
  expect(text).toContain('<array><string>/tools/bun</string><string>/repo/a&amp;b&lt;&quot;&apos;&gt;.ts</string><string>serve</string></array>');
  expect(text).toContain("<key>KeepAlive</key><true/>"); expect(text).toContain("<integer>10</integer>");
  // Background jobs get throttled disk I/O, which stalled the service under memory pressure.
  expect(text).toContain("<key>ProcessType</key><string>Standard</string>"); expect(text).not.toContain("Background");
  expect(text).toContain("/tmp/p&amp;x/logs/serve.log"); expect(servicePATH(ctx)).toBe("/bin:/usr/bin:/tools");
  expect(plist(ctx, ["x"])).toBe(plist(ctx, ["x"]));
  expect(binaryInFile(text, "darwin")).toBe("/tools/bun");
});
test("unit quotes argv and escapes systemd percent, dollar and quotation values", () => {
  const { ctx } = fixture("linux"); ctx.pacerHome = '/tmp/pacer log%"';
  const text = unit(ctx, ['/opt/a b%$"\\', '/repo/x.ts']);
  expect(text).toContain('ExecStart="/opt/a b%%$$\\"\\\\" "/repo/x.ts" "serve"');
  expect(text).toContain('Environment="PATH=/bin:/usr/bin:/opt/tools"');
  expect(text).toContain('StandardOutput="append:/tmp/pacer log%%\\"/logs/serve.log"');
  expect(text).toContain("Restart=always\nRestartSec=10"); expect(text).toContain("WantedBy=default.target");
  expect(binaryInFile(text, "linux")).toBe('/opt/a b%$"\\');
});
test("adopts handwritten launchd plist with one backup, manifest, and correct bootstrap/restart/bootout argv", async () => {
  const { ctx, calls, d, path } = fixture();
  const old = '<plist><dict><key>Label</key><string>com.pacer.serve</string></dict></plist>';
  put(path, old);
  const b = serviceBackend(ctx, d); await b.install();
  const record = readManifest(ctx).planners.service;
  expect(record.pacerArgv).toEqual(["/opt/pacer"]);
  expect(readFileSync(record.files[0].backup!, "utf8")).toBe(old);
  expect(calls.slice(0, 3)).toEqual([["launchctl", "bootout", "gui/501/com.pacer.serve"], ["launchctl", "bootstrap", "gui/501", path], ["launchctl", "print", "gui/501/com.pacer.serve"]]);
  expect(existsSync(join(ctx.pacerHome, "logs"))).toBe(true);
  await b.install(); expect(readdirSync(join(ctx.pacerHome,"backups/service"))).toHaveLength(1);
  expect((await b.status())).toMatchObject({ installed: true, loaded: true, running: true, pid: 456, lastExitCode: 9, healthy: true, binaryMatches: true });
  await b.restart(); expect(calls.at(-1)).toEqual(["launchctl", "kickstart", "-k", "gui/501/com.pacer.serve"]);
  await b.uninstall(); expect(calls.at(-1)).toEqual(["launchctl", "bootout", "gui/501/com.pacer.serve"]);
  expect(existsSync(path)).toBe(false); expect(readManifest(ctx).planners.service).toBeUndefined(); expect(existsSync(record.files[0].backup!)).toBe(true);
});
test("systemd lifecycle and show parsing", async () => {
  const { ctx, calls, d, path } = fixture("linux"); const b = serviceBackend(ctx, d);
  await b.install(); expect(readFileSync(path, "utf8")).toBe(unit(ctx, ["/opt/pacer"]));
  expect(calls.slice(0, 2)).toEqual([["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "--now", "pacer-serve.service"]]);
  expect(await b.status()).toMatchObject({ loaded: true, running: true, pid: 456, lastExitCode: 9, healthy: true, binaryMatches: true });
  await b.restart(); expect(calls.at(-1)).toEqual(["systemctl", "--user", "restart", "pacer-serve.service"]);
  await b.uninstall(); expect(calls.slice(-2)).toEqual([["systemctl", "--user", "disable", "--now", "pacer-serve.service"], ["systemctl", "--user", "daemon-reload"]]);
});
test("recorded status parsers handle absent process and inactive units", () => {
  expect(parseLaunchd("com.pacer.serve = {\n\tpid = 123\n\tlast exit code = -15\n}")).toEqual({ pid: 123, lastExitCode: -15 });
  expect(parseLaunchd("state = waiting")).toEqual({ pid: null, lastExitCode: null });
  expect(parseSystemd("LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\nExecMainStatus=1")).toEqual({ loaded: false, running: false, pid: null, lastExitCode: 1 });
});
test("only not-loaded bootout errors are ignored; bootstrap and verification failures roll back adoption", async () => {
  for (const fail of ["bootstrap", "health", "bootout"]) {
    const { ctx, d, path } = fixture(); put(path, "original");
    ctx.run = async a => a[1] === "bootout" ? { code: 3, stdout: "", stderr: fail === "bootout" ? "permission denied" : "Could not find service" }
      : a[1] === "bootstrap" && fail === "bootstrap" ? { code: 5, stdout: "", stderr: "bad plist" }
      : { code: 0, stdout: "pid = 3", stderr: "" };
    await expect(serviceBackend(ctx, { ...d, fetch: fail === "health" ? (async () => new Response("{}")) as NonNullable<ServiceDeps["fetch"]> : goodFetch }).install()).rejects.toThrow();
    expect(readFileSync(path, "utf8")).toBe("original"); expect(readManifest(ctx).planners.service).toBeUndefined();
  }
});
test("uninstall accepts exact legacy label and refuses unrelated files before bootout", async () => {
  const { ctx, calls, d, path } = fixture(); put(path, "unrelated");
  await expect(serviceBackend(ctx, d).uninstall()).rejects.toThrow("unrecognized"); expect(calls).toHaveLength(0);
  put(path, '<key>Label</key>\n<string>com.pacer.serve</string>'); await serviceBackend(ctx, d).uninstall(); expect(existsSync(path)).toBe(false);
});
test("health validates identity, body, response status, configured port and network failure", async () => {
  const ctx = fakeCtx({ env: { PACER_PORT: "12345" } }); let seen = "";
  expect(await health(ctx, { fetch: (async (url: any) => { seen = String(url); return Response.json({ ok: true, pid:456 }, { headers: { "X-Pacer": "1" } }); }) as NonNullable<ServiceDeps["fetch"]> })).toBe(true);
  expect(seen).toBe("http://127.0.0.1:12345/health");
  for (const r of [Response.json({ ok: true }), Response.json({ ok: false }, { headers: { "X-Pacer": "1" } }), new Response("bad", { status: 503, headers: { "X-Pacer": "1" } })]) expect(await health(ctx, { fetch: (async () => r) as NonNullable<ServiceDeps["fetch"]> })).toBe(false);
  expect(await health(ctx, { fetch: (async () => { throw Error("offline"); }) as NonNullable<ServiceDeps["fetch"]> })).toBe(false);
});
test("restart after update only targets installed files pointing at replaced binary, resolving symlinks", async () => {
  for (const platform of ["darwin", "linux"]) {
    const { ctx, calls, d, path } = fixture(platform);
    expect(await restartAfterUpdate(ctx, "/opt/pacer", d)).toBe(false);
    put(path, platform === "darwin" ? plist(ctx, ["/other/pacer"]) : unit(ctx, ["/other/pacer"]));
    expect(await restartAfterUpdate(ctx, "/opt/pacer", d)).toBe(false); expect(calls).toHaveLength(0);
    const bin = join(ctx.home, "pacer"), link = join(ctx.home, "pacer-link"); put(bin, "bin"); symlinkSync(bin, link);
    put(path, platform === "darwin" ? plist(ctx, [link]) : unit(ctx, [link]));
    expect(await restartAfterUpdate(ctx, bin, d)).toBe(true); expect(calls).toHaveLength(1);
    ctx.run = async () => ({ code: 1, stdout: "", stderr: "restart failed" });
    await expect(restartAfterUpdate(ctx, bin, d)).rejects.toThrow("restart failed");
  }
});
test("update reinstalls a Background launchd job as Standard instead of only restarting it", async () => {
  const { ctx, calls, d, path } = fixture("darwin");
  put(path, plist(ctx, ["/opt/pacer"]).replace("<string>Standard</string>", "<string>Background</string>"));
  expect(await restartAfterUpdate(ctx, "/opt/pacer", d)).toBe(true);
  expect(readFileSync(path, "utf8")).toBe(plist(ctx, ["/opt/pacer"]));
  expect(calls.some(c => c[1] === "bootstrap")).toBe(true); expect(calls.some(c => c[1] === "kickstart")).toBe(false);
  calls.length = 0;
  expect(await restartAfterUpdate(ctx, "/opt/pacer", d)).toBe(true);
  expect(calls.map(c => c[1])).toEqual(["kickstart"]);
});
test("service refuses source argv before any files or commands are changed", async () => {
 const {ctx,d,calls,path}=fixture();delete ctx.env.PACER_BIN;
 for(const argv of [["/bin/bun","/repo/.worktrees/w/src/cli.ts"],["/bin/bun","/repo/src/cli.ts"]]) {
  await expect(serviceBackend(ctx,{...d,argv}).install()).rejects.toThrow("install a release binary or set PACER_BIN");
  expect(existsSync(path)).toBe(false);expect(calls).toHaveLength(0);
 }
});
for(const location of ["orca","git-worktree","dot-worktrees","symlink"] as const)test("service refuses a compiled binary in development workspace: "+location,async()=>{
 const {ctx,d,calls,path}=fixture();delete ctx.env.PACER_BIN;
 const root=location==="orca"?join(ctx.home,"orca/workspaces/repo"):location==="dot-worktrees"?join(ctx.home,"repo/.worktrees/w"):join(ctx.home,"checkout");
 mkdirSync(root,{recursive:true});if(location==="git-worktree")put(join(root,".git"),"gitdir: /tmp/other");
 const bin=join(root,"dist/pacer");put(bin,"binary");let argv=[bin];
 if(location==="symlink"){const actual=join(ctx.home,"orca/workspaces/repo/pacer");put(actual,"binary");const alias=join(ctx.home,"pacer-link");symlinkSync(actual,alias);argv=[alias];}
 await expect(serviceBackend(ctx,{...d,argv}).install()).rejects.toThrow("install a release binary or set PACER_BIN");
 expect(calls).toHaveLength(0);expect(existsSync(path)).toBe(false);
 ctx.env.PACER_BIN=argv[0];await serviceBackend(ctx,{...d,argv}).install();expect(existsSync(path)).toBe(true);
});
test("service backups live under pacerHome rather than the service-manager directory",async()=>{
 for(const platform of ["darwin","linux"]){const {ctx,d,path}=fixture(platform);put(path,"original");await serviceBackend(ctx,d).install();
 const backup=readManifest(ctx).planners.service.files[0].backup!;
 expect(dirname(backup)).toBe(join(ctx.pacerHome,"backups/service"));expect(readFileSync(backup,"utf8")).toBe("original");
 expect(readdirSync(dirname(path))).toEqual([platform==="darwin"?"com.pacer.serve.plist":"pacer-serve.service"]);
 }
});
test("unsupported platform, CLI registration, log tail and strict arguments", async () => {
  const { ctx, d } = fixture(); expect(() => serviceBackend(ctx, { platform: "win32" })).toThrow("not supported");
  put(join(ctx.pacerHome, "logs/serve.log"), "a\nb\nc\n");
  expect(await serviceCli(["logs", "-n", "2"], ctx, d)).toMatchObject({ code: 0, out: "b\nc" });
  expect((await serviceCli(["logs", "-n", "0"], ctx, d)).out).toBe("");
  for (const args of [["logs", "-n", "-1"], ["status", "--bad"], ["install", "extra"], ["logs", "-n"], []]) expect((await serviceCli(args, ctx, d)).code).toBe(2);
  expect((await main(["help"], ctx)).out).toContain("service install");
  expect((await serviceCli(["status", "--json"], ctx, d)).out).toContain('"installed": false');
});
test("doctor service check diagnoses install, restart and binary mismatch", async () => {
  const { ctx, d } = fixture();
  const base = await serviceBackend(ctx, d).status();
  for (const [values, fix] of [[{ installed: false }, "pacer service install"], [{ installed: true, binaryMatches: false }, "pacer service install"], [{ installed: true, binaryMatches: true, healthy: false }, "pacer service restart"], [{ installed: true, binaryMatches: true, healthy: true, running: true }, undefined]] as const) {
    const s = { ...base, ...values }; const checks = await runDoctor(ctx, { service: async () => s });
    expect(checks.find(c => c.name === "Service")).toMatchObject({ level: fix ? "warn" : "ok", ...(fix ? { fix } : {}) });
    expect(checks.find(c => c.name === "Service")?.detail).toContain(`installed: ${s.installed}`);
  }
});
test("cached service-installed snapshot field reflects adoption and uninstall", async () => {
  const { ctx, d } = fixture(); expect(serviceInstalled(ctx, "darwin")).toBe(false);
  await serviceBackend(ctx, d).install(); expect(serviceInstalled(ctx, "darwin")).toBe(true);
  await serviceBackend(ctx, d).uninstall(); expect(serviceInstalled(ctx, "darwin")).toBe(false);
});

for(const platform of ["darwin","linux"])test(`service detects health pid mismatch against ${platform} manager and refuses verification`,async()=>{
 const {ctx,d,path}=fixture(platform);put(path,platform==="darwin"?plist(ctx,["/opt/pacer"]):unit(ctx,["/opt/pacer"]));
 const mismatch={...d,fetch:async()=>Response.json({ok:true,pid:789},{headers:{"X-Pacer":"1"}})};
 expect(await serviceBackend(ctx,mismatch).status()).toMatchObject({pid:456,healthPid:789,healthy:false,warning:expect.stringContaining("pid mismatch")});
 expect((await serviceCli(["status"],ctx,mismatch)).out).toContain("WARNING: health pid mismatch");
 await expect(serviceBackend(ctx,mismatch).install()).rejects.toThrow("pid mismatch");
});
test("launchctl bootstrap retries Input/output error once after one second",async()=>{
 const {ctx,d,calls}=fixture();const original=ctx.run;let attempts=0;const times:number[]=[];
 ctx.run=async a=>{if(a[1]==="bootstrap"){times.push(Date.now());if(++attempts===1){calls.push(a);return {code:5,stdout:"",stderr:"Bootstrap failed: 5: Input/output error"};}}return original(a,1000);};
 await serviceBackend(ctx,d).install();expect(attempts).toBe(2);expect(times[1]-times[0]).toBeGreaterThanOrEqual(950);
});
test("bootstrap permanent I/O failures get only one retry before rollback",async()=>{
 const {ctx,d,path}=fixture();let attempts=0;
 ctx.run=async a=>a[1]==="bootstrap"?(attempts++,{code:5,stdout:"",stderr:"Input/output error"}):{code:0,stdout:"",stderr:""};
 await expect(serviceBackend(ctx,d).install()).rejects.toThrow("Input/output error");expect(attempts).toBe(2);expect(existsSync(path)).toBe(false);
});
