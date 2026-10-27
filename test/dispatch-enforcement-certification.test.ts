import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import { certificateStatus, certifyExecutor, observeClaudeCanary, strictClaudeLaunch, type EnforcementTarget } from "../src/dispatch/enforcement";
import { resolveEnforcementTarget } from "../src/dispatch/enforcement";
import { validateStrategy } from "../src/config/strategy";

function fixture(){
  const ctx=fakeCtx(),dir=tmpDir(),binary=join(dir,"agent"),hook=join(dir,"hooks.json");
  writeFileSync(binary,"agent v1");writeFileSync(hook,"hook v1");
  const target:EnforcementTarget={runner:"codex",account:"codex",agent:"codex",version:"0.164.0",binary,controlFiles:[hook],launchMode:"headless",launchArgs:["codex","exec"]};
  return {ctx,target,hook};
}

test("only a canary that observes a blocked native child certifies a runner",async()=>{
  const {ctx,target}=fixture();
  expect(certificateStatus(ctx,target).state).toBe("uncertified");
  expect((await certifyExecutor(ctx,target,async()=>({attempted:false,blocked:false,childStarted:false}))).state).toBe("uncertified");
  expect((await certifyExecutor(ctx,target,async()=>({attempted:true,blocked:true,childStarted:false}))).state).toBe("certified");
  expect(certificateStatus(ctx,target).state).toBe("certified");
});
test("Claude canary requires a correlated native tool denial",()=>{
  const init=JSON.stringify({type:"system",subtype:"init",tools:["Task"]});
  const use=JSON.stringify({type:"assistant",message:{content:[{type:"tool_use",name:"Agent",id:"tool-1"}]}});
  const denied=JSON.stringify({type:"user",message:{content:[{type:"tool_result",tool_use_id:"tool-1",is_error:true,content:"PreToolUse:Agent hook error: pacer: native subagents are blocked for this managed attempt"}]}});
  expect(observeClaudeCanary([init,use,denied].join("\n"),"Task")).toMatchObject({attempted:true,blocked:true,childStarted:false});
  expect(observeClaudeCanary([init,use].join("\n"),"Task").blocked).toBe(false);
  expect(observeClaudeCanary([init,use,denied.replace('"is_error":true','"is_error":false')].join("\n"),"Task")).toMatchObject({blocked:false,childStarted:true});
  expect(observeClaudeCanary([use,denied].join("\n"),"Task").blocked).toBe(false);
});

test("binary, hook, launch or account changes and expiry invalidate a certificate",async()=>{
  const {ctx,target,hook}=fixture();
  await certifyExecutor(ctx,target,async()=>({attempted:true,blocked:true,childStarted:false}));
  expect(certificateStatus(ctx,{...target,account:"other"}).state).not.toBe("certified");
  expect(certificateStatus(ctx,{...target,launchArgs:["codex","resume"]}).state).not.toBe("certified");
  expect(certificateStatus(ctx,{...target,guardArgv:["/another/pacer"]}).state).not.toBe("certified");
  writeFileSync(hook,"hook changed and longer");
  expect(certificateStatus(ctx,target).state).toBe("stale");
  expect(certificateStatus({...ctx,now:ctx.now+86401},target).state).not.toBe("certified");
});

test("target uses the selected account and repository control files",async()=>{
  const {ctx:base}=fixture(),home=tmpDir(),repo=tmpDir(),account=join(home,"named-claude"),binary=join(home,"claude");
  writeFileSync(binary,"cli");
  const ctx={...base,home,which:(name:string)=>name==="claude"?binary:null,run:async()=>({code:0,stdout:"2.1.281 (Claude Code)\n",stderr:""})};
  const strategy=validateStrategy({planner:"claude-code",accounts:{"claude-code":{kind:"claude"},claude1:{kind:"claude",source:"pacer",home:account}},runners:{"claude-code#claude1":{agent:"claude-code",account:"claude1"}}},"test");
  const target=await resolveEnforcementTarget(ctx,strategy,"claude-code#claude1",repo);
  expect(target).toMatchObject({agent:"claude-code",account:"claude1",version:"2.1.281",binary});
  expect(target.controlFiles).toContain(join(account,"settings.json"));
  expect(target.controlFiles).toContain(join(repo,".claude","settings.json"));
  expect(target.launchArgs).toContain("--dangerously-skip-permissions");
});
test("strict Claude launches attach the current Pacer guard without editing account settings",()=>{
  const ctx=fakeCtx({env:{PACER_BIN:"/opt/pacer"}}),dir=tmpDir();
  const original=["claude","-p","--","hello"];
  const argv=strictClaudeLaunch(ctx,original,dir);
  expect(original).toEqual(["claude","-p","--","hello"]);
  expect(argv.slice(0,5)).toEqual(["claude","-p","--settings",join(dir,"strict-claude-settings.json"),"--"]);
  const settings=JSON.parse(readFileSync(join(dir,"strict-claude-settings.json"),"utf8"));
  expect(settings.hooks.PreToolUse[0].matcher).toBe("Agent|Task");
  expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain("/opt/pacer guard --planner claude-code");
});
