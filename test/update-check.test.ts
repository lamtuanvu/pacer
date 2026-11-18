import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { checkForUpdate, readUpdateCheck, updateAvailable, updateLine, UPDATE_CACHE_S } from "../src/update/check";
import { updateChannel } from "../src/update/channel";
import { cliNightlyUrl } from "../src/update/manifest";
import { compareVersions } from "../src/update/version";
import { main } from "../src/cli";
import { fakeCtx, tmpDir } from "./helpers";
const response = (version: string) => new Response(JSON.stringify({version}));
test("dev builds only offer releases newer than their package version, including cached checks", async () => {
  const ctx = fakeCtx();
  const current = "0.2.3+12.gabc1234";
  for (const latest of ["0.2.2", "0.2.3", "0.2.3+other"]) {
    expect(updateLine(await checkForUpdate(ctx, { current, force: true, fetch: async () => response(latest) }))).toBe("");
  }
  await checkForUpdate(ctx, { current: "0.2.2", force: true, fetch: async () => response("0.2.3") });
  expect(updateLine(await checkForUpdate(ctx, { current, fetch: async () => { throw Error("must use cache"); } }))).toBe("");
  expect(updateLine(await checkForUpdate(ctx, { current, force: true, fetch: async () => response("0.2.4") }))).toContain("Update available: pacer 0.2.4");
});
test("semver releases, prereleases and numeric components", () => {
 for (const [a,b] of [["1.10.0","1.2.0"],["1.0.0","1.0.0-rc.2"],["1.0.0-rc.10","1.0.0-rc.2"],["1.0.0-beta","1.0.0-1"]]) { expect(compareVersions(a,b)).toBe(1); expect(compareVersions(b,a)).toBe(-1); }
 expect(compareVersions("1.0.0","1.0.0")).toBe(0);
});
test("check caches for 24h, refreshes at expiry and on force, compares against current binary", async () => {
 const ctx=fakeCtx(); let calls=0;
 const options={current:"1.0.0",fetch:async()=>{calls++;return response("1.1.0");}};
 expect(updateLine(await checkForUpdate(ctx,options))).toContain("pacer 1.1.0 (you have 1.0.0)");
 await checkForUpdate({...ctx,now:ctx.now+UPDATE_CACHE_S-1},options); expect(calls).toBe(1);
 expect(updateLine(await checkForUpdate(ctx,{...options,current:"1.2.0"}))).toBe("");
 await checkForUpdate({...ctx,now:ctx.now+UPDATE_CACHE_S},options); expect(calls).toBe(2);
 await checkForUpdate(ctx,{...options,force:true}); expect(calls).toBe(3);
 expect(JSON.parse(readFileSync(join(ctx.pacerHome,"update-check.json"),"utf8"))).toMatchObject({current:"1.0.0",latest:"1.1.0",checkedAt:ctx.now});
});
test("opt-outs suppress forced checks and cached notices", async () => {
 const ctx=fakeCtx();mkdirSync(ctx.pacerHome,{recursive:true});let calls=0;
 const options={force:true,fetch:async()=>{calls++;return response("1.0.0");}};
 expect(await checkForUpdate({...ctx,env:{PACER_NO_UPDATE_CHECK:"1"}},options)).toBeNull();
 writeFileSync(join(ctx.pacerHome,"strategy.yaml"),"update_check: false # disabled\n");
 expect(await checkForUpdate(ctx,options)).toBeNull();
 mkdirSync(join(ctx.pacerHome,"strategies"));writeFileSync(join(ctx.pacerHome,"active"),"economy");writeFileSync(join(ctx.pacerHome,"strategies/economy.yaml"),"update_check: false\n");
 expect(await checkForUpdate(ctx,options)).toBeNull();expect(calls).toBe(0);
});
test("network, malformed metadata, timeout and cache-write failures do not throw",async()=>{
 const ctx=fakeCtx();
 for(const fetch of [async()=>{throw Error("offline");},async()=>new Response("bad"),async()=>new Promise<Response>(()=>{})]) {
  const result=await checkForUpdate(ctx,{force:true,fetch,timeoutMs:10});expect(result?.error).toBeTruthy();
 }
 expect(JSON.parse(readFileSync(join(ctx.pacerHome,"update-check.json"),"utf8"))).toHaveProperty("error");
 expect((await checkForUpdate({...ctx,pacerHome:"/dev/null"},{fetch:async()=>response("1.0.0")}))?.latest).toBe("1.0.0");
});
test("CLI check only needs latest.json, accepts file bases, always succeeds offline and reports no plugin",async()=>{
 const ctx=fakeCtx(),root=tmpDir();writeFileSync(join(root,"latest.json"),JSON.stringify({version:"99.0.0"}));ctx.env.PACER_RELEASE_BASE=pathToFileURL(root).href;
 mkdirSync(join(ctx.pacerHome,"orca-plugin"),{recursive:true});writeFileSync(join(ctx.pacerHome,"orca-plugin/.pacer-managed"),JSON.stringify({version:"0.0.1"}));
 const result=await main(["update","--check","--json"],ctx);expect(result.code).toBe(0);expect(JSON.parse(result.out)).toMatchObject({latest:"99.0.0",available:true,plugin:null});
 expect((await main(["update","--check"],ctx)).out).not.toContain("Orca plugin");
 ctx.env.PACER_RELEASE_BASE=pathToFileURL(join(root,"missing")).href;expect((await main(["update","--check"],ctx)).code).toBe(0);
});
test("status appends cached update line only to text reports and respects opt-out",async()=>{
 const ctx=fakeCtx();mkdirSync(ctx.pacerHome,{recursive:true});
 writeFileSync(join(ctx.pacerHome,"strategy.yaml"),"planner: codex\nproviders:\n  codex: {}\n");
 const run=(args:string[])=>main(["status",...args],ctx);
 expect((await run([])).out).not.toContain("Update available:");
 await checkForUpdate(ctx,{fetch:async()=>response("99.0.0")});
 const text=await run([]);expect(text.code).toBe(0);expect(text.out).toContain("Update available: pacer 99.0.0");
 for(const flags of [["--line"],["--json"],["--hook","codex"]]){const result=await run(flags);expect(result.code).toBe(0);expect(result.out).not.toContain("Update available:");}
 ctx.env.PACER_NO_UPDATE_CHECK="1";expect((await run([])).out).not.toContain("Update available:");
});

const CLI_NIGHTLY = "https://raw.githubusercontent.com/lamtuanvu/pacer/desktop-updates/cli-nightly.json";
const LATEST = "https://github.com/lamtuanvu/pacer/releases/latest/download/latest.json";
function onChannel(channel: "stable" | "nightly") {
  const ctx = fakeCtx(); mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), `planner: codex\nupdate_channel: ${channel} # chosen\n`);
  return ctx;
}
function feeds(bodies: Record<string, string | Error>) {
  const urls: string[] = [];
  const fetch = async (url: string) => {
    urls.push(url);
    const body = bodies[url];
    if (body instanceof Error) throw body;
    return body === undefined ? new Response("missing", { status: 404 }) : new Response(body);
  };
  return { urls, fetch };
}
test("nightly channel offers the newer nightly over stable", async () => {
  const ctx = onChannel("nightly"), f = feeds({ [LATEST]: '{"version":"0.15.1"}', [CLI_NIGHTLY]: '{"version":"0.16.0-nightly.202611170000"}' });
  const check = await checkForUpdate(ctx, { current: "0.15.1", force: true, fetch: f.fetch });
  expect(check).toMatchObject({ latest: "0.16.0-nightly.202611170000", current: "0.15.1" });
  expect(check?.error).toBeUndefined();
  expect(updateLine(check)).toContain("pacer 0.16.0-nightly.202611170000");
  expect(f.urls.sort()).toEqual([LATEST, CLI_NIGHTLY].sort());
  expect(readFileSync(join(ctx.pacerHome, "update-check.json"), "utf8")).toBe(`{"checkedAt":${ctx.now},"latest":"0.16.0-nightly.202611170000","current":"0.15.1","channel":"nightly"}\n`);
});
test("nightly channel offers stable when it is newer than every nightly", async () => {
  const ctx = onChannel("nightly"), f = feeds({ [LATEST]: '{"version":"0.16.0"}', [CLI_NIGHTLY]: '{"version":"0.16.0-nightly.202611170000"}' });
  expect((await checkForUpdate(ctx, { current: "0.16.0-nightly.202611170000", force: true, fetch: f.fetch }))?.latest).toBe("0.16.0");
});
test("nightly channel falls back to stable when cli-nightly.json is unreachable and records the error", async () => {
  const ctx = onChannel("nightly"), f = feeds({ [LATEST]: '{"version":"0.15.2"}' });
  const check = await checkForUpdate(ctx, { current: "0.15.1", force: true, fetch: f.fetch });
  expect(check).toMatchObject({ latest: "0.15.2", error: `download failed: ${CLI_NIGHTLY} (HTTP 404)` });
  expect(updateAvailable(check)).toBe(true);
  // A stable version in the nightly feed is invalid there, and both feeds failing reports the nightly feed's error.
  const g = feeds({ [LATEST]: "<html>", [CLI_NIGHTLY]: '{"version":"0.15.2"}' });
  expect(await checkForUpdate(ctx, { current: "0.15.1", force: true, fetch: g.fetch })).toMatchObject({ latest: "0.15.2", error: 'cli-nightly.json has no valid nightly "version" (got "0.15.2")' });
  const h = feeds({ [LATEST]: '{"version":"0.15.3"}', [CLI_NIGHTLY]: "<html>" });
  expect((await checkForUpdate(ctx, { current: "0.15.1", force: true, fetch: h.fetch }))?.error).toStartWith("JSON Parse error");
});
test("stable channel never reads cli-nightly.json", async () => {
  for (const ctx of [onChannel("stable"), fakeCtx()]) {
    const f = feeds({ [LATEST]: '{"version":"0.15.1"}', [CLI_NIGHTLY]: '{"version":"0.16.0-nightly.202611170000"}' });
    expect((await checkForUpdate(ctx, { current: "0.15.0", force: true, fetch: f.fetch }))?.latest).toBe("0.15.1");
    expect(f.urls).toEqual([LATEST]);
    expect(JSON.parse(readFileSync(join(ctx.pacerHome, "update-check.json"), "utf8")).channel).toBe("stable");
  }
});
test("switching channel invalidates the cache", async () => {
  const ctx = onChannel("stable"), path = join(ctx.pacerHome, "strategy.yaml");
  const f = feeds({ [LATEST]: '{"version":"0.15.1"}', [CLI_NIGHTLY]: '{"version":"0.16.0-nightly.202611170000"}' });
  await checkForUpdate(ctx, { current: "0.15.1", fetch: f.fetch });
  writeFileSync(path, "planner: codex\nupdate_channel: 'nightly'\n");
  expect(readUpdateCheck(ctx, "0.15.1")).toBeNull();
  expect((await checkForUpdate(ctx, { current: "0.15.1", fetch: f.fetch }))?.latest).toBe("0.16.0-nightly.202611170000");
  expect(f.urls).toHaveLength(3);
  writeFileSync(path, "planner: codex\n");
  // A failed check on the new channel does not keep the other channel's latest.
  const offline = feeds({});
  expect(await checkForUpdate(ctx, { current: "0.15.1", fetch: offline.fetch })).toMatchObject({ latest: null, error: `download failed: ${LATEST} (HTTP 404)` });
  // Caches written before channels existed belong to the stable channel.
  writeFileSync(join(ctx.pacerHome, "update-check.json"), JSON.stringify({ checkedAt: ctx.now, latest: "0.15.1", current: "0.15.1" }));
  expect(readUpdateCheck(ctx, "0.15.1")?.latest).toBe("0.15.1");
  writeFileSync(path, "update_channel: nightly\n");
  expect(readUpdateCheck(ctx, "0.15.1")).toBeNull();
});
test("a nightly install on the stable channel is not offered an older stable", async () => {
  const ctx = onChannel("stable"), f = feeds({ [LATEST]: '{"version":"0.15.2"}' });
  const check = await checkForUpdate(ctx, { current: "0.16.0-nightly.202611170000", force: true, fetch: f.fetch });
  expect(check?.latest).toBe("0.15.2");
  expect(updateAvailable(check)).toBe(false);
  expect(updateLine(check)).toBe("");
});
test("update_channel reads only a top-level nightly value and defaults to stable", () => {
  const ctx = fakeCtx(); mkdirSync(join(ctx.pacerHome, "strategies"), { recursive: true });
  expect(updateChannel(ctx)).toBe("stable");
  for (const [text, channel] of [["update_channel: nightly", "nightly"], ['a: 1\nupdate_channel:\t"nightly"  # on\r\n', "nightly"], ["update_channel: 'nightly'", "nightly"],
    ["update_channel: stable", "stable"], [" update_channel: nightly", "stable"], ["update_channel: nightly x", "stable"], ["update_channel: \"nightly'", "stable"], ["x:\n  update_channel: nightly", "stable"]] as const) {
    writeFileSync(join(ctx.pacerHome, "strategy.yaml"), text);
    expect(updateChannel(ctx), text).toBe(channel);
  }
  writeFileSync(join(ctx.pacerHome, "active"), "work\n"); writeFileSync(join(ctx.pacerHome, "strategies/work.yaml"), "update_channel: stable\n");
  expect(updateChannel(ctx)).toBe("stable");
});
test("the nightly feed URL follows the release base", () => {
  expect(cliNightlyUrl()).toBe(CLI_NIGHTLY);
  expect(cliNightlyUrl("file:///tmp/feed")).toBe("file:///tmp/feed/cli-nightly.json");
});
