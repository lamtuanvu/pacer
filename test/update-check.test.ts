import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { checkForUpdate, installedPlugin, updateLine, UPDATE_CACHE_S } from "../src/update/check";
import { compareVersions } from "../src/update/version";
import { main } from "../src/cli";
import { fakeCtx, tmpDir } from "./helpers";
const response = (version: string) => new Response(JSON.stringify({version}));
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
test("CLI check only needs latest.json, accepts file bases, always succeeds offline and reports plugin",async()=>{
 const ctx=fakeCtx(),root=tmpDir();writeFileSync(join(root,"latest.json"),JSON.stringify({version:"99.0.0"}));ctx.env.PACER_RELEASE_BASE=pathToFileURL(root).href;
 mkdirSync(join(ctx.pacerHome,"orca-plugin"),{recursive:true});writeFileSync(join(ctx.pacerHome,"orca-plugin/.pacer-managed"),JSON.stringify({version:"0.0.1"}));
 const result=await main(["update","--check","--json"],ctx);expect(result.code).toBe(0);expect(JSON.parse(result.out)).toMatchObject({latest:"99.0.0",available:true,plugin:{version:"0.0.1",mode:"live"}});
 expect(installedPlugin(ctx)?.hint).toContain("pacer plugin install");
 writeFileSync(join(ctx.pacerHome,"plugin-version.json"),JSON.stringify({version:"0.0.2",mode:"bootstrap"}));expect(installedPlugin(ctx)?.hint).toContain("Refresh, then Update plugin");
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
