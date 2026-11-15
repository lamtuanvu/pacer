import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { main } from "../src/cli";
import { readManifest } from "../src/install/manifest";
import { runDoctor } from "../src/install/doctor";
import { health, binaryInFile, parseLaunchd, parseSystemd, plist, RELOAD_AFTER_RETURN, restartAfterUpdate, serviceBackend, serviceInstalled, servicePath, servicePATH, unit, type ServiceDeps } from "../src/service";
import { serviceCli } from "../src/service/cli";
import { MANAGED_BY_DESKTOP_MESSAGE, readOwner, writeOwner } from "../src/install/owner";
import { fakeCtx, tmpDir } from "./helpers";
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
  expect(calls.slice(0, 4)).toEqual([["launchctl", "print", "gui/501/com.pacer.serve"], ["launchctl", "bootout", "gui/501/com.pacer.serve"], ["launchctl", "bootstrap", "gui/501", path], ["launchctl", "print", "gui/501/com.pacer.serve"]]);
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
  expect(calls.slice(0, 3)).toEqual([["systemctl", "--user", "show", "pacer-serve.service", "--property=Environment"], ["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "--now", "pacer-serve.service"]]);
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
test("service registration exists during activation and is removed after refusal", async () => {
  for (const platform of ["darwin", "linux"]) {
    const { ctx, d, path } = fixture(platform);
    let selected: string | null = null;
    let presentAtReload = false;
    ctx.run = async argv => {
      if (argv.includes("daemon-reload")) presentAtReload ||= existsSync(path);
      if (argv.includes("bootstrap") || argv.includes("enable")) {
        selected = binaryInFile(readFileSync(path, "utf8"), platform);
        return { code: 1, stdout: "", stderr: "fixed fixture activation refusal" };
      }
      return { code: argv.includes("print") || argv.includes("show") ? 1 : 0,
        stdout: "", stderr: "not found" };
    };
    await expect(serviceBackend(ctx, d).install()).rejects.toThrow("fixed fixture activation refusal");
    expect(String(selected)).toBe("/opt/pacer");
    if (platform === "linux") expect(presentAtReload).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(readManifest(ctx).planners.service).toBeUndefined();
  }
});
test("service install commits after recovering an interrupted registration write", async () => {
  for (const platform of ["darwin", "linux"]) {
    const { ctx, d, path } = fixture(platform);
    const journal = join(ctx.pacerHome, "install-transaction.json");
    put(path, "B-interrupted");
    put(journal, JSON.stringify({ schema: 1, files: [{ path, before: "A-original", after: "B-interrupted" }], manifestHash: "not committed" }));
    await serviceBackend(ctx, d).install();
    expect(readFileSync(path, "utf8")).toBe(platform === "darwin" ? plist(ctx, ["/opt/pacer"]) : unit(ctx, ["/opt/pacer"]));
    expect(existsSync(journal)).toBe(false);
    expect(readManifest(ctx).planners.service.files[0].action).toBe("edited");
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
test("a dev (source) invocation refuses install, uninstall and restart against the real launchd label", async () => {
  const { ctx, d, calls, path } = fixture(); delete ctx.env.PACER_BIN;
  put(path, '<key>Label</key>\n<string>com.pacer.serve</string>');
  const argv = ["/bin/bun", "/repo/src/cli.ts"];
  for (const op of ["install", "uninstall", "restart"] as const) {
    await expect(serviceBackend(ctx, { ...d, argv })[op]()).rejects.toThrow("refusing to manage the login service from a source (dev) invocation");
    expect(calls).toHaveLength(0);
  }
  expect(existsSync(path)).toBe(true); // uninstall never reached rmSync
});
test("PACER_ALLOW_REAL_INSTALL=1 is the only way past the dev-invocation refusal", async () => {
  const { ctx, d, calls, path } = fixture(); delete ctx.env.PACER_BIN;
  put(path, '<key>Label</key>\n<string>com.pacer.serve</string>');
  const argv = ["/bin/bun", "/repo/src/cli.ts"];
  process.env.PACER_ALLOW_REAL_INSTALL = "1";
  try {
    await serviceBackend(ctx, { ...d, argv }).restart();
    expect(calls.some(c => c[0] === "launchctl" && c[1] === "kickstart")).toBe(true);
  } finally { delete process.env.PACER_ALLOW_REAL_INSTALL; }
  calls.length = 0;
  await expect(serviceBackend(ctx, { ...d, argv }).restart()).rejects.toThrow("refusing to manage the login service from a source (dev) invocation");
  expect(calls).toHaveLength(0);
});
test("an installed or compiled binary (single-element argv) is unaffected by the dev-invocation refusal", async () => {
  const { ctx, d, calls, path } = fixture(); delete ctx.env.PACER_BIN;
  put(path, '<key>Label</key>\n<string>com.pacer.serve</string>');
  // A real compiled pacer's own argv, from either a release binary or an explicit PACER_BIN, is a single element.
  await serviceBackend(ctx, { ...d, argv: ["/opt/pacer"] }).restart();
  expect(calls.some(c => c[0] === "launchctl" && c[1] === "kickstart")).toBe(true);
  calls.length = 0;
  await serviceBackend(ctx, { ...d, argv: ["/opt/pacer"] }).uninstall();
  expect(calls.some(c => c[0] === "launchctl" && c[1] === "bootout")).toBe(true);
  expect(existsSync(path)).toBe(false);
});
test("a fixture (compiled sandbox) service label is unaffected by the dev-invocation refusal even with dev argv", async () => {
  const { ctx, d, calls, path } = fixture();
  delete ctx.env.PACER_BIN;
  const fixtureLabel = "com.pacer.live.0123456789abcdef0123456789abcdef.service";
  put(path, `<key>Label</key>\n<string>${fixtureLabel}</string>`);
  await serviceBackend(ctx, { ...d, argv: ["/bin/bun", "/repo/src/cli.ts"], label: fixtureLabel }).restart();
  expect(calls.some(c => c[0] === "launchctl" && c[1] === "kickstart" && c[3] === `gui/501/${fixtureLabel}`)).toBe(true);
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

// Every service-manager call below stays behind the injected runner.
function ownedJob(platform: string, home: string, port?: number): string {
  return platform === "darwin"
    ? `gui/501/com.pacer.serve = {\n\tenvironment = {\n\t\tPACER_HOME => ${home}\n${port === undefined ? "" : `\t\tPACER_PORT => ${port}\n`}\t}\n\tpid = 456\n}`
    : `Environment="PACER_HOME=${home}"${port === undefined ? "" : ` PACER_PORT=${port}`}\n`;
}
function ownerProbe(f: ReturnType<typeof fixture>, stdout: string, code = 0) {
  const original = f.ctx.run;
  let first = true;
  f.ctx.run = async (args, timeout, options) => {
    if (first && (args[1] === "print" || args.includes("--property=Environment"))) {
      first = false; f.calls.push(args);
      return { code, stdout, stderr: code ? "Could not find service" : "" };
    }
    return original(args, timeout, options);
  };
}
for (const platform of ["darwin", "linux"]) {
  for (const mismatch of ["home", "port"]) test(`${platform} refuses foreign ${mismatch} before any write or service mutation`, async () => {
    const f = fixture(platform);
    const home = mismatch === "home" ? join(f.ctx.home, "another pacer") : f.ctx.pacerHome;
    const port = mismatch === "port" ? 5000 : 4317;
    put(f.path, "original service");
    ownerProbe(f, ownedJob(platform, home, port));
    await expect(serviceBackend(f.ctx, f.d).install()).rejects.toMatchObject({
      name: "CoreError", code: "conflict",
      message: `Another pacer (PACER_HOME ${home}, port ${port}) owns the login service. Stop it with "pacer service uninstall" from that pacer, or rerun with --replace.`,
    });
    expect(readFileSync(f.path, "utf8")).toBe("original service");
    expect(existsSync(f.ctx.pacerHome)).toBe(false);
    expect(f.calls).toEqual([platform === "darwin" ? ["launchctl", "print", "gui/501/com.pacer.serve"] : ["systemctl", "--user", "show", "pacer-serve.service", "--property=Environment"]]);
  });
  for (const scenario of ["same", "absent", "replace", "symlink"]) test(`${platform} installs when owner is ${scenario}`, async () => {
    const f = fixture(platform);
    let home = scenario === "replace" ? join(f.ctx.home, "foreign") : f.ctx.pacerHome;
    if (scenario === "symlink") {
      mkdirSync(f.ctx.pacerHome); home = join(f.ctx.home, "alias"); symlinkSync(f.ctx.pacerHome, home);
    }
    ownerProbe(f, ownedJob(platform, home), scenario === "absent" ? 3 : 0);
    const result = await serviceCli(["install", ...(scenario === "replace" ? ["--replace"] : [])], f.ctx, f.d);
    expect(result.code).toBe(0);
    expect(readFileSync(f.path, "utf8")).toContain("Managed by pacer service");
    expect(f.calls.some(a => a.includes(platform === "darwin" ? "bootstrap" : "enable"))).toBe(true);
  });
}
test("launchd owner ignores inherited, default and nested environment blocks", async () => {
  const f = fixture();
  ownerProbe(f, `gui/501/com.pacer.serve = {\n\tinherited environment = {\n\t\tPACER_HOME => /foreign\n\t}\n\tdefault environment = {\n\t\tPACER_PORT => 9000\n\t}\n\tendpoint = {\n\t\tenvironment = {\n\t\t\tPACER_HOME => /foreign\n\t\t}\n\t}\n\tenvironment = {\n\t\tPACER_HOME => ${f.ctx.pacerHome}\n\t}\n}`);
  expect((await serviceCli(["install"], f.ctx, f.d)).code).toBe(0);
});
test("service install CLI reports a foreign owner with a failing exit code", async () => {
  const f = fixture(); ownerProbe(f, ownedJob("darwin", "/foreign"));
  expect(await serviceCli(["install"], f.ctx, f.d)).toMatchObject({ code: 1, err: expect.stringContaining("Another pacer") });
});

test("a successful service install claims cli ownership only when unclaimed or already cli", async () => {
  const { ctx, d } = fixture();
  expect(readOwner(ctx)).toBeNull();
  expect((await serviceCli(["install"], ctx, d)).code).toBe(0);
  expect(readOwner(ctx)).toMatchObject({ owner: "cli", executable: "/opt/pacer" });
  // A later successful install from the same CLI keeps (re-records) cli ownership.
  expect((await serviceCli(["install"], ctx, d)).code).toBe(0);
  expect(readOwner(ctx)).toMatchObject({ owner: "cli", executable: "/opt/pacer" });
});

test("service install and uninstall defer to a desktop owner with exit code 2", async () => {
  const { ctx, d } = fixture();
  writeOwner(ctx, { owner: "desktop", executable: "/Applications/pacer.app/Contents/Resources/pacer", at: 1 });
  expect(await serviceCli(["install"], ctx, d)).toEqual({ code: 2, out: "", err: `pacer service: ${MANAGED_BY_DESKTOP_MESSAGE}` });
  expect(await serviceCli(["uninstall"], ctx, d)).toEqual({ code: 2, out: "", err: `pacer service: ${MANAGED_BY_DESKTOP_MESSAGE}` });
  // Read-only commands stay unaffected.
  expect((await serviceCli(["status"], ctx, d)).code).toBe(0);
});

test("the bundled CLI (PACER_BIN matching the recorded desktop executable) is never blocked, and never overrides desktop ownership", async () => {
  const { ctx, d } = fixture();
  writeOwner(ctx, { owner: "desktop", executable: "/opt/pacer", at: 1 });
  const result = await serviceCli(["install"], ctx, d);
  expect(result.code).toBe(0);
  // Its own install succeeded, but ownership stays with the desktop: claimCliOwnership defers.
  expect(readOwner(ctx)).toMatchObject({ owner: "desktop", executable: "/opt/pacer" });
});

test("the desktop's own bundled CLI running `service install` never claims a cli record pointing into the app bundle", async () => {
  const { ctx, d } = fixture();
  ctx.env.PACER_BIN = "/Applications/pacer.app/Contents/Resources/pacer";
  expect(readOwner(ctx)).toBeNull(); // no record at all yet: the bug this guards against has no existing desktop record to defer to
  const result = await serviceCli(["install"], ctx, { ...d, argv: [ctx.env.PACER_BIN] });
  expect(result.code).toBe(0);
  expect(readOwner(ctx)).toBeNull();
});

test("--release-ownership hands a desktop-owned installation back to this CLI instead of deferring", async () => {
  const { ctx, d } = fixture();
  // No pre-app backup here: the handback falls back to the already-standalone command at the
  // conventional link path (never to the PACER_BIN/app-bundle path; see ownership-handback.ts).
  put(join(ctx.home, ".local/bin/pacer"), "standalone");
  writeOwner(ctx, { owner: "desktop", executable: "/Applications/pacer.app/Contents/Resources/pacer", at: 1 });
  const result = await serviceCli(["install", "--release-ownership"], ctx, d);
  expect(result.code).toBe(0);
  expect(readOwner(ctx)?.owner).toBe("cli");
  expect(readOwner(ctx)?.executable).toMatch(/\.local\/bin\/pacer$/);
  expect(result.out).toContain("ownership released to this CLI");
});

test("service install rejects --release-ownership combined with an unknown flag", async () => {
  const { ctx, d } = fixture();
  expect((await serviceCli(["install", "--release-ownership", "--bogus"], ctx, d)).code).toBe(2);
});
// The fixture's `launchctl print` reports the job's pid as 456.
const inJob = { pid: 456, ppid: 1 }, frontDoorChild = { pid: 900, ppid: 456 }, outside = { pid: 900, ppid: 901 };
test("the service reloads its own launchd job from a detached process instead of booting itself out", async () => {
  const { ctx, calls, d, path } = fixture();
  const previous = '<plist><dict><key>Label</key><string>com.pacer.serve</string></dict></plist>';
  put(path, previous);
  const spawned: { argv: string[]; log: string; previous: string | null }[] = [];
  const spawnDetached = (argv: string[], log: string) => {
    const copy = argv.at(-1)!;
    spawned.push({ argv, log, previous: copy && existsSync(copy) ? readFileSync(copy, "utf8") : null });
  };
  const notes = await serviceBackend(ctx, { ...d, spawnDetached, self: inJob }).install();
  // Only the probe ran in-process: bootout here would kill this very process before its bootstrap.
  expect(calls).toEqual([["launchctl", "print", "gui/501/com.pacer.serve"]]);
  expect(readFileSync(path, "utf8")).toBe(plist(ctx, ["/opt/pacer"], "com.pacer.serve"));
  expect(notes).toContain(RELOAD_AFTER_RETURN); expect(notes.reloadPending).toBe(true);
  expect(spawned).toHaveLength(1);
  const [{ argv, log }] = spawned;
  expect(argv.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
  expect(argv.slice(3, 7)).toEqual(["pacer-service-reload", "gui/501/com.pacer.serve", "gui/501", path]);
  expect(argv[2]).toContain('/bin/launchctl bootout "$1"'); expect(argv[2]).toContain('/bin/launchctl bootstrap "$2" "$3"');
  expect(argv[7]).toMatch(/backups\/service\/com\.pacer\.serve\.reload-[0-9a-f-]+\.plist$/);
  expect(spawned[0].previous).toBe(previous);
  expect(log).toBe(join(ctx.pacerHome, "logs/serve.log"));
});
test("the TypeScript core under the front door reloads from outside too; a fresh install has nothing to restore", async () => {
  const { ctx, calls, d } = fixture();
  const spawned: string[][] = [];
  await serviceBackend(ctx, { ...d, self: frontDoorChild, spawnDetached: argv => spawned.push(argv) }).install();
  expect(calls).toHaveLength(1);
  expect(spawned[0].at(-1)).toBe("");
});
test("callers outside the job, including sessions that inherited its environment, still reload in-process", async () => {
  const f = fixture(); f.ctx.env.XPC_SERVICE_NAME = "com.pacer.serve";
  const other: string[][] = [];
  const notes = await serviceBackend(f.ctx, { ...f.d, self: outside, spawnDetached: argv => other.push(argv) }).install();
  expect(notes).not.toContain(RELOAD_AFTER_RETURN); expect(notes.reloadPending).toBeUndefined();
  expect(other).toEqual([]);
  expect(f.calls[1]).toEqual(["launchctl", "bootout", "gui/501/com.pacer.serve"]);
});
test("a helper that cannot start leaves no copy behind and says the registration is saved", async () => {
  const { ctx, d, path } = fixture();
  put(path, "previous registration");
  let copy = "";
  const install = serviceBackend(ctx, { ...d, self: inJob, spawnDetached: argv => { copy = argv.at(-1)!; throw new Error("spawn EAGAIN"); } }).install();
  await expect(install).rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining("registration is saved") });
  expect(copy).not.toBe(""); expect(existsSync(copy)).toBe(false);
});
function reloadRun(argv: string[], bin: string) {
  const script = argv[2].replaceAll("/bin/launchctl", join(bin, "launchctl")).replace(/\/bin\/sleep \d+/g, ":");
  return Bun.spawnSync(["/bin/sh", "-c", script, ...argv.slice(3)]);
}
async function reloadFixture(launchctl: string, leaveRestore?: (path: string) => void) {
  const { ctx, d, path } = fixture();
  put(path, "previous registration");
  leaveRestore?.(`${path}.restore`);
  let argv: string[] = [];
  await serviceBackend(ctx, { ...d, self: inJob, spawnDetached: a => { argv = a; } }).install();
  const bin = join(ctx.pacerHome, "fake-bin"), log = join(ctx.pacerHome, "launchctl.log");
  put(join(bin, "launchctl"), `#!/bin/sh\necho "$*" >> "${log}"\n${launchctl}\nexit 0\n`);
  Bun.spawnSync(["chmod", "+x", join(bin, "launchctl")]);
  const out = reloadRun(argv, bin);
  return { path, argv, out: out.stdout.toString(), calls: () => readFileSync(log, "utf8").trim().split("\n") };
}
test("the reload script retries bootstrap and restores the previous registration when the new one never loads", async () => {
  const r = await reloadFixture(`[ "$1" = bootstrap ] && ! grep -q "previous registration" "$3" && exit 5\n[ "$1" = print ] && echo "state = running"`);
  expect(r.out).toContain("restored the previous registration");
  expect(readFileSync(r.path, "utf8")).toBe("previous registration");
  const calls = r.calls();
  expect(calls[0]).toBe("bootout gui/501/com.pacer.serve");
  expect(calls.filter(line => line.startsWith("bootstrap"))).toHaveLength(6);
  expect(existsSync(r.argv.at(-1)!)).toBe(false);
});
test("the reload script restores the previous registration when the new one loads but does not stay running", async () => {
  // Every bootstrap succeeds; the job is reported running only once the previous registration is back.
  const r = await reloadFixture(`[ "$1" = bootstrap ] && cp "$3" "$(dirname "$0")/loaded"\n[ "$1" = print ] && grep -q "previous registration" "$(dirname "$0")/loaded" && echo "state = running"`);
  expect(r.out).toContain("did not stay running"); expect(r.out).toContain("restored the previous registration");
  expect(readFileSync(r.path, "utf8")).toBe("previous registration");
  expect(r.calls().filter(line => line.startsWith("bootout"))).toHaveLength(2);
  expect(existsSync(`${r.path}.restore`)).toBe(false);
});
test("the reload script keeps a registration that loads and stays running", async () => {
  const r = await reloadFixture(`[ "$1" = print ] && echo "state = running"`);
  expect(r.out).toBe("");
  expect(readFileSync(r.path, "utf8")).not.toBe("previous registration");
  expect(r.calls()).toEqual(["bootout gui/501/com.pacer.serve", `bootstrap gui/501 ${r.path}`, "print gui/501/com.pacer.serve"]);
  expect(existsSync(r.argv.at(-1)!)).toBe(false);
});
// Stale leftover from an earlier crashed restore must not leak into the next one; a symlink there
// must not carry the restore through to a file outside the registration’s fixture.
const restoreFails = `[ "$1" = bootstrap ] && ! grep -q "previous registration" "$3" && exit 5\n[ "$1" = print ] && echo "state = running"`;
test("the reload script clears a stale .restore file and a symlink there without touching the symlink target", async () => {
  // The success path never reaches the restore copy, so the stale .restore file is gone only
  // because of the leading rm; the restore takeover itself stays with the symlink half below.
  const plain = await reloadFixture(`[ "$1" = print ] && echo "state = running"`, restore => writeFileSync(restore, "stale junk"));
  expect(plain.out).toBe("");
  expect(readFileSync(plain.path, "utf8")).not.toBe("previous registration");
  expect(existsSync(`${plain.path}.restore`)).toBe(false);
  const outside = join(tmpDir(), "outside-target.txt");
  writeFileSync(outside, "outside");
  const linked = await reloadFixture(restoreFails, restore => symlinkSync(outside, restore));
  expect(linked.out).toContain("restored the previous registration");
  expect(readFileSync(outside, "utf8")).toBe("outside");
  expect(existsSync(outside)).toBe(true);
  expect(readFileSync(linked.path, "utf8")).toBe("previous registration");
  expect(existsSync(`${linked.path}.restore`)).toBe(false);
});
