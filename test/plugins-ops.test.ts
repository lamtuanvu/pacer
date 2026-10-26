import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { installFixture } from "../conformance/install";
import { callOp, opNames } from "../src/api/ops";
import { helloBody, toApiError } from "../src/api/protocol";
import { renderProtocolDoc } from "../scripts/protocol-doc";
import { BLOCKED_OPS } from "../scripts/live/proxy";
import { shutdownPlugins } from "../src/plugins";
import { setPluginGrant, pluginsConfig } from "../src/plugins/config";
import { fakeCtx, tmpDir } from "./helpers";

const contexts: ReturnType<typeof fakeCtx>[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => shutdownPlugins(ctx)));
});

function home() {
  const dir = tmpDir();
  const ctx = fakeCtx({ home: dir, pacerHome: join(dir, ".pacer"), env: { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` }, now: Date.now() / 1000 });
  contexts.push(ctx);
  symlinkSync(join(import.meta.dir, "..", "node_modules"), join(dir, "node_modules"), "dir");
  mkdirSync(join(ctx.pacerHome, "plugins"), { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n");
  return ctx;
}
const codeOf = async (p: Promise<unknown>) => { try { await p; return "no error"; } catch (e) { return toApiError(e).code; } };

test("the registry, hello and docs name the plugin operations and event", () => {
  for (const op of ["plugin.list", "plugin.enable", "plugin.disable", "plugin.remove", "plugin.doctor"]) { expect(opNames()).toContain(op); expect(renderProtocolDoc()).toContain(`### \`${op}\``); }
  expect(helloBody().events).toContain("plugin");
  expect(BLOCKED_OPS["plugin.remove"]).toBeDefined();
});

test("list, enable with grant, doctor, disable and remove through the operations", async () => {
  const ctx = home();
  installFixture("good", join(ctx.pacerHome, "plugins"));
  expect((await callOp(ctx, "plugin.list", {}) as {plugins:unknown[]}).plugins).toEqual(expect.arrayContaining([expect.objectContaining({id:"fx-good",state:"needs_grant"})]));
  expect(await callOp(ctx, "plugin.enable", { id: "fx-good" })).toMatchObject({ state: "needs_grant", needs: ["log", "config.get"] });
  const {plugins} = await callOp(ctx, "plugin.list", {}) as {plugins:{id:string;expectedConsent:string|null}[]};
  expect(await codeOf(callOp(ctx, "plugin.enable", { id: "fx-good", grant: true }))).toBe("conflict");
  expect(await callOp(ctx, "plugin.enable", { id: "fx-good", grant: true, expectedConsent: plugins.find(p=>p.id==="fx-good")?.expectedConsent })).toEqual({ id: "fx-good", state: "idle" });
  const { reports } = await callOp(ctx, "plugin.doctor", { id: "fx-good" }) as { reports: { ok: boolean }[] };
  expect(reports[0]).toMatchObject({ ok: true });
  expect(await callOp(ctx, "plugin.disable", { id: "fx-good" })).toEqual({ id: "fx-good", state: "disabled" });
  expect(await callOp(ctx, "plugin.remove", { id: "fx-good" })).toEqual({ id: "fx-good", removed: true });
  const remaining=(await callOp(ctx, "plugin.list", {}) as {plugins:{id:string;bundled:boolean}[]}).plugins;
  expect(remaining.some(plugin=>plugin.id==="fx-good")).toBe(false);
  expect(remaining.some(plugin=>plugin.bundled)).toBe(true);
  expect(await codeOf(callOp(ctx, "plugin.enable", { id: "fx-good" }))).toBe("unknown_plugin");
  expect(await codeOf(callOp(ctx, "plugin.enable", { id: "Bad" }))).toBe("invalid_input");
  await shutdownPlugins(ctx);
}, 20000);

test("grant rejects a changed manifest without persisting unseen capabilities", async () => {
  const ctx = home();
  const dir = installFixture("good", join(ctx.pacerHome, "plugins"));
  const list = async () => (await callOp(ctx, "plugin.list", {}) as {plugins:{id:string;expectedConsent:string|null;version:string;capabilities:{name:string;scopes?:string[]}[]}[]}).plugins.find(p=>p.id==="fx-good")!;
  const old = await list();
  const path = join(dir, "pacer-plugin.json");
  const manifest = JSON.parse(readFileSync(path,"utf8"));
  manifest.version = "2.0.0";
  manifest.capabilities = [{name:"events.subscribe"}];
  writeFileSync(path, JSON.stringify(manifest));
  expect(await codeOf(callOp(ctx, "plugin.enable", {id:"fx-good",grant:true,expectedConsent:old.expectedConsent}))).toBe("conflict");
  expect(await callOp(ctx,"plugin.enable",{id:"fx-good"})).toMatchObject({state:"needs_grant",needs:["events.subscribe"]});
  const current = await list();
  expect(current.expectedConsent).not.toBe(old.expectedConsent);
  expect(await callOp(ctx,"plugin.enable",{id:"fx-good",grant:true,expectedConsent:current.expectedConsent})).toMatchObject({state:"idle"});
  const newManifest = JSON.parse(readFileSync(path,"utf8"));
  newManifest.capabilities = [{name:"events.subscribe",scopes:["wider"]}];
  writeFileSync(path,JSON.stringify(newManifest));
  expect(await codeOf(callOp(ctx,"plugin.enable",{id:"fx-good",grant:true,expectedConsent:current.expectedConsent}))).toBe("conflict");
  expect((await list()).capabilities).toEqual([{name:"events.subscribe",scopes:["wider"]}]);
  expect((await list()).version).toBe("2.0.0");
  expect(await callOp(ctx,"plugin.enable",{id:"fx-good"})).toMatchObject({state:"needs_grant"});
  installFixture("slow",join(ctx.pacerHome,"plugins"));
  expect(await codeOf(callOp(ctx,"plugin.enable",{id:"fx-slow",grant:true,expectedConsent:current.expectedConsent}))).toBe("conflict");
});

test("persisted legacy name-only grants require fresh scoped consent", async () => {
  const ctx = home();
  const dir = installFixture("good", join(ctx.pacerHome, "plugins"));
  const path = join(dir, "pacer-plugin.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.capabilities = [{name:"config.get",scopes:["narrow"]}];
  writeFileSync(path, JSON.stringify(manifest));
  await setPluginGrant(ctx,"fx-good",{version:"1.0.0",capabilities:["config.get"]});
  const list = async () => (await callOp(ctx,"plugin.list",{}) as {plugins:{id:string;state:string;expectedConsent:string|null}[]}).plugins.find(plugin=>plugin.id==="fx-good")!;
  expect((await list()).state).toBe("needs_grant");
  manifest.capabilities = [{name:"config.get",scopes:["*"]}];
  writeFileSync(path,JSON.stringify(manifest));
  expect((await list()).state).toBe("needs_grant");
  expect(await callOp(ctx,"plugin.enable",{id:"fx-good"})).toMatchObject({state:"needs_grant",needs:["config.get"]});
  expect(pluginsConfig(ctx).installed["fx-good"]?.consent).toBeUndefined();
  const reviewed = await list();
  expect(await callOp(ctx,"plugin.enable",{id:"fx-good",grant:true,expectedConsent:reviewed.expectedConsent ?? undefined})).toMatchObject({state:"idle"});
  expect(pluginsConfig(ctx).installed["fx-good"]?.consent).toBe(reviewed.expectedConsent!);
});
