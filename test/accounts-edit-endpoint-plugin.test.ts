import {expect,test} from "bun:test";
import {mkdirSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {fakeCtx} from "./helpers";
import {applyEdit} from "../src/core/accounts";
import {loadStrategy} from "../src/config/strategy";
import {readActivity} from "../src/activity/log";
import {shutdownPlugins} from "../src/plugins";

function setup(accounts:Record<string,unknown>={}){
 const ctx=fakeCtx({now:Date.now()/1000});mkdirSync(ctx.pacerHome,{recursive:true});
 writeFileSync(join(ctx.pacerHome,"strategy.yaml"),JSON.stringify({planner:"claude-code",accounts:{"claude-code":{kind:"claude"},...accounts},plugins:{disabled:["pacer-endpoints"]}}));
 return ctx;
}
const work={kind:"endpoint",usage:"unmetered",connection:{api:"openai-compatible",base_url:"http://localhost/v1",key:"none",models:[{id:"m",context:128000,output:16000,tools:true}]}};

test("strategy edits succeed without an endpoint plugin when no endpoint account exists (F4)",async()=>{
 const ctx=setup();
 try {
  await expect(applyEdit(ctx,doc=>doc.setIn(["pacing","policy"],"priority"))).resolves.toContain("priority");
  expect(loadStrategy(ctx).pacing.policy).toBe("priority");
  expect(readActivity(ctx).entries.filter(e=>e.level==="warn")).toEqual([]);
 } finally {await shutdownPlugins(ctx);}
});

test("strategy edits with endpoint accounts succeed and warn when the endpoint plugin is unavailable (F4)",async()=>{
 const ctx=setup({work});
 try {
  expect(loadStrategy(ctx).accounts.work.connection).toBeDefined();
  await expect(applyEdit(ctx,doc=>doc.setIn(["pacing","policy"],"priority"))).resolves.toContain("priority");
  const warn=readActivity(ctx).entries.find(e=>e.kind==="config"&&e.level==="warn");
  expect(warn?.text).toContain("endpoint configuration was not updated");
 } finally {await shutdownPlugins(ctx);}
});
