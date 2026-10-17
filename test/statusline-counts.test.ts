import {expect,test,spyOn} from "bun:test";
import {join} from "node:path";
import {fakeCtx} from "./helpers";
import {main} from "../src/cli";
import {ensureToken} from "../src/serve/http";
import {writeFileSync,mkdirSync} from "node:fs";
async function context(){const ctx=fakeCtx();await Bun.write(join(ctx.pacerHome,"strategy.yaml"),"planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n");ensureToken(ctx);return ctx;}
test("status --line reads v2 counts with authentication",async()=>{
 const ctx=await context();const token=ensureToken(ctx);
 const request=spyOn(globalThis,"fetch").mockImplementation((async(input: Parameters<typeof fetch>[0],options?: Parameters<typeof fetch>[1])=>{
  expect(String(input)).toEndWith("/v2/snapshot");expect(new Headers(options?.headers).get("authorization")).toBe(`Bearer ${token}`);
  return Response.json({snapshot:{counts:{running:2,attention:1}}});
 }) as typeof fetch);
 try{const r=await main(["status","--line"],ctx);expect(r.code).toBe(0);expect(r.out).toContain("▸2 ⚑1");}finally{request.mockRestore();}
});
test("status --line falls back without counts for fresh local data",async()=>{
 const ctx=await context();ctx.env.PACER_PORT="1";
 mkdirSync(join(ctx.pacerHome,"link"),{recursive:true});writeFileSync(join(ctx.pacerHome,"link/latest.json"),JSON.stringify({v:1,seq:0,at:ctx.now,budget:null,mode:null,tasks:[],alerts:[],console:null}));
 const r=await main(["status","--line"],ctx);expect(r.out).toContain("Budget");expect(r.out).not.toContain("▸");expect(r.out).not.toContain("⚑");
});
test("status --line reports offline when the stored snapshot is stale",async()=>{
 const ctx=await context();ctx.env.PACER_PORT="1";
 mkdirSync(join(ctx.pacerHome,"link"),{recursive:true});writeFileSync(join(ctx.pacerHome,"link/latest.json"),JSON.stringify({v:1,seq:0,at:ctx.now-121,budget:null,mode:null,tasks:[],alerts:[],console:null}));
 expect((await main(["status","--line"],ctx)).out).toBe("pacer not running · pacer serve");
});
