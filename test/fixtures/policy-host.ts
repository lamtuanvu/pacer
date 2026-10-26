import {registerFixtureCleanup} from "../fixture-cleanup";
import {chmodSync,existsSync,mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {fakeCtx,tmpDir} from "../helpers";
import {shutdownPlugins} from "../../src/plugins";
import {fixtureConsent} from "./plugin-consent";
export function policyGateFixture(verdict:unknown,delay=0,repo=tmpDir()){
 const ctx=fakeCtx({env:{PATH:process.env.PATH},now:Date.now()/1000});
 const pacerHome=ctx.pacerHome;
 registerFixtureCleanup(()=>shutdownPlugins({pacerHome}));
 const dir=join(ctx.pacerHome,"plugins","fx-policy");mkdirSync(dir,{recursive:true});
 const manifest={id:"fx-policy",version:"1.0.0",publisher:"test",host:"^1",entry:"main.ts",contributes:{policy:{}},capabilities:[]};
 const config={planner:"claude-code",providers:{"claude-code":{},codex:{}},plugins:{policy:{mode:"closed"},installed:{"fx-policy":{version:"1.0.0",capabilities:[],consent:fixtureConsent(manifest)}}}};
 writeFileSync(join(ctx.pacerHome,"strategy.yaml"),JSON.stringify(config));
 writeFileSync(join(dir,"pacer-plugin.json"),JSON.stringify(manifest));
 writeFileSync(join(dir,"settings.json"),JSON.stringify({verdict,delay}));
 writeFileSync(join(dir,"main.ts"),`#!${process.execPath}\nimport {readFileSync,appendFileSync} from "node:fs";for await(const line of console){const r=JSON.parse(line);if(!r.id)continue;let result;if(r.method==="plugin.hello")result={protocol:r.params.protocol,id:"fx-policy",version:"1.0.0",contributes:["policy"]};else{appendFileSync("calls.jsonl",JSON.stringify(r.params)+"\\n");const s=JSON.parse(readFileSync("settings.json","utf8"));await Bun.sleep(s.delay);result=s.verdict;}console.log(JSON.stringify({jsonrpc:"2.0",id:r.id,result}));}\n`);chmodSync(join(dir,"main.ts"),0o755);
 let launches=0;const spawn=()=>{launches++;return 1;};
 return {ctx,repo,dir,spawn,launches:()=>launches,config,calls:()=>existsSync(join(dir,"calls.jsonl"))?readFileSync(join(dir,"calls.jsonl"),"utf8").trim().split("\n").filter(Boolean):[]};
}
