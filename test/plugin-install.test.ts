import pkg from "../package.json";
import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readManifest } from "../src/install/manifest";
import { pluginCli } from "../src/plugin/cli";
import { PLUGIN_FILES } from "../src/plugin/assets.generated";
import { fakeCtx, tmpDir } from "./helpers";

function setup() {
  const home = tmpDir();
  const userData = join(home, "orca-user-data");
  const f = fakeRun();
  const ctx = fakeCtx({ home, pacerHome: join(home, ".pacer"), env: { PACER_BIN: "/opt/pacer", PACER_ORCA_USER_DATA: userData }, run: f.run });
  return { home, userData, ctx, fake: f };
}
function fakeRun() {
  const calls: string[][] = [];
  return { calls, run: async (argv: string[]) => { calls.push(argv); return { code: 99, stdout: "", stderr: "unexpected process" }; } };
}

test("plugin install records generated files and leaves panel output untracked", async () => {
  const { ctx, fake } = setup();
  const root = join(ctx.pacerHome, "orca-plugin");
  const r = await pluginCli(["install"], ctx);
  expect(r.code).toBe(0);
  for (const file of ["orca-plugin.json", "assets/pacer-mark.svg", "worker.mjs", ".pacer-managed", "panel/live.html"]) expect(existsSync(join(root, file))).toBe(true);
  expect(readManifest(ctx).planners["orca-plugin"]?.files.map(f => f.action)).toEqual(["created", "created", "created", "created"]);
  expect(readManifest(ctx).planners["orca-plugin"]?.files.some(f => f.path.endsWith("live.html"))).toBe(false);
  expect(r.out).toContain("development plugin paths");
  const manifest = JSON.parse(PLUGIN_FILES.find(f => f.rel === "orca-plugin.json")!.text);
  const listed = r.out.match(/It asks for: ([^;]+);/)![1]!.split(", ");
  expect(listed).toEqual(manifest.capabilities.map((cap: { kind: string }) => cap.kind));
  expect(fake.calls).toEqual([]);
});

test("plugin re-install leaves a worker-rewritten panel and all files unchanged", async () => {
  const { ctx } = setup();
  await pluginCli(["install"], ctx);
  const root = join(ctx.pacerHome, "orca-plugin");
  const before = PLUGIN_FILES.map(f => readFileSync(join(root, f.rel), "utf8"));
  const panel = join(root, "panel/live.html");
  writeFileSync(panel, "worker rendered this");
  const r = await pluginCli(["install"], ctx);
  expect(r.out).toContain("already installed, nothing changed");
  expect(PLUGIN_FILES.map(f => readFileSync(join(root, f.rel), "utf8"))).toEqual(before);
  expect(readFileSync(panel, "utf8")).toBe("worker rendered this");
});

test("plugin uninstall removes generated files, bridge key and empty directories", async () => {
  const { ctx, userData, fake } = setup();
  const root = join(ctx.pacerHome, "orca-plugin");
  await pluginCli(["install"], ctx);
  const data = join(userData, "plugins-data", "lamtuanvu.pacer");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(root, ".pacer-panel-serve.json"), '{"at":100}');
  writeFileSync(join(data, "storage.json"), '{"link":{"v":1},"other":"keep"}');
  const r = await pluginCli(["uninstall"], ctx);
  expect(r.code).toBe(0);
  expect(existsSync(root)).toBe(false);
  expect(JSON.parse(readFileSync(join(data, "storage.json"), "utf8"))).toEqual({ other: "keep" });
  expect(r.out).toContain("development plugin paths");
  expect(fake.calls).toEqual([]);
});

test("plugin uninstall reports missing install", async () => {
  const { ctx } = setup();
  expect(await pluginCli(["uninstall"], ctx)).toMatchObject({ code: 1 });
});

test("plugin set validates values and writes isolated Orca settings", async () => {
  const { ctx, userData } = setup();
  await pluginCli(["install"], ctx);
  expect(await pluginCli(["set", "transport", "http"], ctx)).toMatchObject({ code: 0 });
  expect(JSON.parse(readFileSync(join(userData, "plugins-data", "lamtuanvu.pacer", "settings.json"), "utf8"))).toEqual({ transport: "http" });
  expect((await pluginCli(["set", "transport", "ftp"], ctx)).code).toBe(2);
  expect((await pluginCli(["set", "port", "0"], ctx)).code).toBe(2);
  const settings = join(userData, "plugins-data", "lamtuanvu.pacer", "settings.json");
  writeFileSync(settings, "unreadable");
  expect((await pluginCli(["set", "transport", "bridge"], ctx)).code).toBe(1);
  expect(readFileSync(settings, "utf8")).toBe("unreadable");
});

test("plugin paths stay under a temporary home", async () => {
  const { ctx, home } = setup();
  expect(ctx.home).not.toBe(homedir());
  const before = readdirSync(home).sort();
  await pluginCli(["install"], ctx);
  expect(readdirSync(home).sort()).toEqual([...before, ".pacer"].sort());
  expect(ctx.pacerHome.startsWith(ctx.home)).toBe(true);
});

test("plugin set refuses absent installation",async()=>{
 const {ctx,userData}=setup();const r=await pluginCli(["set","port","1234"],ctx);
 expect(r.code).toBe(1);expect(r.err).toContain("not installed");expect(existsSync(userData)).toBe(false);
});
test("plugin setting message requires reload",async()=>{
 const {ctx}=setup();await pluginCli(["install"],ctx);
 expect((await pluginCli(["set","port","1234"],ctx)).out).toContain("takes effect after reloading the plugin in Orca");
});
test("plugin status probes configured port and home",async()=>{
 const {ctx}=setup();await pluginCli(["install"],ctx);
 const alternate=join(ctx.home,"alternate");mkdirSync(alternate);writeFileSync(join(alternate,"token"),"alternate-token");
 const requests:{path:string;auth:string|null}[]=[];
 const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch(req){requests.push({path:new URL(req.url).pathname,auth:req.headers.get("authorization")});return Response.json({ok:true},{headers:{"X-Pacer":"1"}});}});
 try{
  await pluginCli(["set","port",String(server.port)],ctx);await pluginCli(["set","pacerHome",alternate],ctx);
  const result=await pluginCli(["status"],ctx);
  expect(result.out).toContain("serve: reachable");
  expect(requests).toEqual([{path:"/health",auth:null},{path:"/link",auth:"Bearer alternate-token"}]);
 }finally{server.stop(true);}
});

async function installLegacy(ctx: ReturnType<typeof setup>["ctx"]) {
  const { runInstall } = await import("../src/install/txn");
  await runInstall({ ctx, pacerArgv: ["/opt/pacer"] }, "orca-plugin", tx => {
    const root = join(ctx.pacerHome, "orca-plugin");
    for (const f of PLUGIN_FILES) {
      const text = f.rel === "orca-plugin.json" ? JSON.stringify({ ...JSON.parse(f.text), publisher: "pacer" }) : f.text;
      tx.edit(join(root, f.rel), () => text, []);
    }
    tx.edit(join(root, ".pacer-managed"), () => "pacer.pacer\n", []);
  });
}

test("legacy plugin status detects the old identity and install migrates the tracked folder", async () => {
  const { ctx, userData } = setup();
  await installLegacy(ctx);
  const root = join(ctx.pacerHome, "orca-plugin");
  const data = join(userData, "plugins-data", "pacer.pacer");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "storage.json"), JSON.stringify({ link: { v: 1 }, other: "keep" }));
  expect((await pluginCli(["status"], ctx)).out).toContain("legacy plugin installed");
  const result = await pluginCli(["install"], ctx);
  expect(result.code).toBe(0);
  expect(result.out).toContain("migrated the previous plugin identity");
  expect(JSON.parse(readFileSync(join(root, "orca-plugin.json"), "utf8")).publisher).toBe("lamtuanvu");
  expect(JSON.parse(readFileSync(join(root, ".pacer-managed"), "utf8")).version).toBe(pkg.version);
  expect(JSON.parse(readFileSync(join(data, "storage.json"), "utf8"))).toEqual({ other: "keep" });
  expect((await pluginCli(["status"], ctx)).out).not.toContain("legacy plugin installed");
  expect((await pluginCli(["uninstall"], ctx)).code).toBe(0);
  expect(existsSync(root)).toBe(false);
});

test("uninstall recognizes a legacy tracked plugin and preserves unrelated legacy storage", async () => {
  const { ctx, userData } = setup();
  await installLegacy(ctx);
  const data = join(userData, "plugins-data", "pacer.pacer");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "storage.json"), '{"link":{},"other":1}');
  expect((await pluginCli(["uninstall"], ctx)).code).toBe(0);
  expect(existsSync(join(ctx.pacerHome, "orca-plugin"))).toBe(false);
  expect(JSON.parse(readFileSync(join(data, "storage.json"), "utf8"))).toEqual({ other: 1 });
});

test("managed marker is versioned JSON and repeated install preserves its timestamp", async()=>{
 const {ctx}=setup();await pluginCli(["install"],ctx);const path=join(ctx.pacerHome,"orca-plugin/.pacer-managed");
 const first=readFileSync(path,"utf8"), marker=JSON.parse(first);
 expect(marker.version).toBe(pkg.version);expect(Number.isNaN(Date.parse(marker.installedAt))).toBe(false);
 await pluginCli(["install"],ctx);expect(readFileSync(path,"utf8")).toBe(first);
});
test("install and status report marketplace and managed copies without editing Orca",async()=>{
 const {ctx,userData}=setup();const market=join(userData,"plugins","lamtuanvu.pacer");mkdirSync(market,{recursive:true});writeFileSync(join(market,"sentinel"),"verified");
 const result=await pluginCli(["install"],ctx);expect(result.out).toContain("Uninstall the marketplace pacer");expect(result.out).toContain(join(ctx.pacerHome,"orca-plugin"));
 const status=await pluginCli(["status"],ctx);expect(status.out).toContain("marketplace: installed");expect(status.out).toContain("development: installed");
 expect(readdirSync(market)).toEqual(["sentinel"]);expect(readFileSync(join(market,"sentinel"),"utf8")).toBe("verified");
});
