import {expect,test} from "bun:test";
import {mkdirSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {fakeCtx} from "./helpers";
import {boundedJson,dispatchDatabase} from "../src/dispatch/store";
import {listDispatchModels,storedObservations} from "../src/dispatch/refresh";
import {EXTENSION_METHODS} from "../src/plugins/protocol";

test("observed model lists remain suggestions outside the declared allowlist",()=>{
 const ctx=fakeCtx({now:Date.now()/1000});mkdirSync(ctx.pacerHome,{recursive:true});
 writeFileSync(join(ctx.pacerHome,"strategy.yaml"),"planner: claude-code\naccounts: {claude-code: {kind: claude}, codex: {kind: codex}}\nrunners:\n  codex:\n    models: [{id: provider/allowed, tier: medium}]\n");
 const observation={source:"plugin:catalog",scope:{runner:"codex",account:"codex"},method:"models",state:"known",observedAt:ctx.now,expiresAt:ctx.now+60,value:{models:[{id:"provider/other",tier:"frontier",strengths:[]}]}};
 dispatchDatabase(ctx).query("INSERT INTO work_observations(id,at,data) VALUES(?,?,?)").run("catalog",ctx.now,boundedJson(observation));
 const inventory=listDispatchModels(ctx);
 expect(inventory.models.filter(m=>m.runner==="codex").map(m=>m.binding)).toEqual([{kind:"exact",id:"provider/allowed"}]);
 expect(inventory.advertised).toMatchObject([{model:{id:"provider/other"},authorized:false}]);
 expect(EXTENSION_METHODS["observation.observe"].result.safeParse(storedObservations(ctx)).success).toBe(true);
});
test("explicit runner and model discovery allowlist admits an observed model without inferred tier",()=>{
 const ctx=fakeCtx({now:Date.now()/1000});mkdirSync(ctx.pacerHome,{recursive:true});
 writeFileSync(join(ctx.pacerHome,"strategy.yaml"),"planner: claude-code\naccounts: {claude-code: {kind: claude}, codex: {kind: codex}}\nrunners: {codex: {}}\ndispatch:\n  discovery: {enabled: true, runners: [codex], models: [provider/other]}\n");
 const observation={source:"plugin:catalog",scope:{runner:"codex",account:"codex"},method:"models",state:"known",observedAt:ctx.now,expiresAt:ctx.now+60,value:{models:[{id:"provider/other",tier:"frontier",strengths:["coding"]},{id:"provider/unlisted",tier:"frontier",strengths:[]}]}};
 dispatchDatabase(ctx).query("INSERT INTO work_observations(id,at,data) VALUES(?,?,?)").run("catalog",ctx.now,boundedJson(observation));
 const inventory=listDispatchModels(ctx);
 expect(inventory.models.find(m=>m.binding.kind==="exact"&&m.binding.id==="provider/other")).toMatchObject({tier:"unknown",strengths:[],provenance:"observed"});
 expect(inventory.models.some(m=>m.binding.kind==="exact"&&m.binding.id==="provider/unlisted")).toBe(false);
});
