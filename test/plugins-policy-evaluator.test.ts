import {expect, test} from "bun:test";
import {evaluatePolicy, freezePolicySnapshot} from "../src/plugins/policy-evaluator";

const delegate = {decision:"delegate",input:{goal:"work",repo:"repo",kind:null,requestedExecutor:null,placement:"auto"}} as const;
const snapshot = (mode:"open"|"closed"="open") => freezePolicySnapshot({mode,fingerprint:"generation1",policies:[{id:"z",generation:"1"},{id:"a",generation:"1"}]});

test("ordered policies see fresh cumulative amendments without mutating caller input",async()=>{
  const seen:string[]=[];
  const result=await evaluatePolicy(snapshot(),delegate,{eligibleRunnerIds:["runner"],allowedPlacements:["auto","current","new"],validateDelegate:()=>true,call:async(p,params)=>{
    seen.push(p.id);
    if(params.decision!=="delegate") throw Error("wrong decision");
    if(p.id==="a") {params.input.goal="mutated";return {verdict:"amend",amend:{placement:"new"}};}
    expect(params.input).toEqual({...delegate.input,placement:"new"});
    return {verdict:"allow"};
  }});
  expect(seen).toEqual(["a","z"]);
  expect(result.params.input).toEqual({...delegate.input,placement:"new"});
  expect(delegate.input.goal).toBe("work");
  expect(()=>result.revalidate("changed")).toThrow("changed");
});

test("delegate amendments may only restrict: no executor steering and no isolation downgrade (B3)",async()=>{
  const requested={decision:"delegate",input:{...delegate.input,requestedExecutor:"runner",placement:"new"}} as const;
  const options={eligibleRunnerIds:["runner","other"],allowedPlacements:["auto","current","new"] as const,validateDelegate:()=>true};
  for(const [input,amend] of [[delegate,{requestedExecutor:"runner"}],[requested,{requestedExecutor:"other"}],[requested,{requestedExecutor:null}],[requested,{placement:"current"}],[requested,{placement:"auto"}],[delegate,{placement:"current"}]] as const) {
    await expect(evaluatePolicy(snapshot("closed"),input,{...options,call:async()=>({verdict:"amend",amend})}),JSON.stringify(amend)).rejects.toMatchObject({code:"not_allowed"});
    const failures:{pluginId:string;reason:string}[]=[];
    const open=await evaluatePolicy(snapshot(),input,{...options,onFailure:event=>{failures.push(event);},call:async()=>({verdict:"amend",amend})});
    expect(open.params).toEqual(input);
    expect(failures.map(f=>f.pluginId)).toEqual(["a","z"]);
    expect(failures[0]!.reason).toMatch(/Executor amendments are refused|Placement amendments may only move/);
  }
  // Unchanged values and moves toward an isolated worktree remain allowed.
  const kept=await evaluatePolicy(snapshot("closed"),requested,{...options,call:async()=>({verdict:"amend",amend:{requestedExecutor:"runner",placement:"new"}})});
  expect(kept.params).toEqual(requested);
  const isolated=await evaluatePolicy(snapshot("closed"),{decision:"delegate",input:{...delegate.input,placement:"current"}},{...options,call:async()=>({verdict:"amend",amend:{placement:"new"}})});
  expect(isolated.params.decision==="delegate"&&isolated.params.input.placement).toBe("new");
});

test("closed mode vetoes listed unavailable policy plugins before calling any policy (B2)",async()=>{
  const calls:string[]=[],vetoes:unknown[]=[],failures:unknown[]=[];
  const source={mode:"closed" as const,fingerprint:"g",policies:[{id:"a",generation:"1"}],unavailable:[{id:"gone",reason:"needs_grant"}]};
  await expect(evaluatePolicy(freezePolicySnapshot(source),delegate,{onVeto:v=>{vetoes.push(v);},call:async p=>{calls.push(p.id);return {verdict:"allow"};}})).rejects.toMatchObject({code:"not_allowed",hint:"plugin gone"});
  expect(calls).toEqual([]);expect(vetoes).toEqual([{pluginId:"gone",decision:"delegate",reason:"Policy plugin is unavailable (needs_grant)"}]);
  const open=await evaluatePolicy(freezePolicySnapshot({...source,mode:"open"}),delegate,{onFailure:v=>{failures.push(v);},call:async p=>{calls.push(p.id);return {verdict:"allow"};}});
  expect(open.params).toEqual(delegate);expect(calls).toEqual(["a"]);expect(failures).toEqual([{pluginId:"gone",decision:"delegate",reason:"Policy plugin is unavailable (needs_grant)"}]);
});

test("explicit veto rejects even in open mode with bounded safe activity",async()=>{
  const activity:unknown[]=[];
  await expect(evaluatePolicy(snapshot(),delegate,{call:async()=>({verdict:"veto",reason:"denied"}),onVeto:v=>{activity.push(v);}})).rejects.toMatchObject({code:"not_allowed",hint:"plugin a"});
  expect(activity).toEqual([{pluginId:"a",decision:"delegate",reason:"denied"}]);
});

for(const response of [{verdict:"amend",amend:{goal:"replace"}},{verdict:"amend",amend:{requestedExecutor:"unknown"}},{verdict:"allow",extra:true},{verdict:"allow",reason:"x".repeat(513)}]) {
  test(`invalid verdict follows frozen mode ${JSON.stringify(response).slice(0,90)}`,async()=>{
    expect((await evaluatePolicy(snapshot(),delegate,{call:async()=>response})).params).toEqual(delegate);
    await expect(evaluatePolicy(snapshot("closed"),delegate,{call:async()=>response})).rejects.toMatchObject({code:"not_allowed"});
  });
}

test("route exclusions are cumulative, retain order, and attribute first remover",async()=>{
  const input={decision:"route",input:{taskId:"task",candidates:["b","a","c"]}} as const;
  const result=await evaluatePolicy(snapshot(),input,{call:async(p,params)=>{
    if(params.decision!=="route") throw Error("wrong decision");
    expect(params.input.candidates).toEqual(p.id==="a"?["b","a","c"]:["b","c"]);
    return {verdict:"amend",amend:{exclude:p.id==="a"?["a"]:["c"]}};
  }});
  if(result.params.decision!=="route") throw Error("wrong decision");
  expect(result.params.input.candidates).toEqual(["b"]);
  expect(result.excludedBy).toEqual({a:"a",c:"z"});
});

test("review amendment and invented route candidates fail closed",async()=>{
  for(const params of [{decision:"review",input:{taskId:"task",revision:1,state:"done",verdict:"accept"}},{decision:"route",input:{taskId:"task",candidates:["a"]}}]) {
    await expect(evaluatePolicy(snapshot("closed"),params,{call:async()=>({verdict:"amend",amend:{exclude:["invented"]}})})).rejects.toMatchObject({code:"not_allowed"});
  }
});

test("failure and actual serialized oversize obey mode without truncation",async()=>{
  for(const call of [async()=>{throw Error("secret raw transport");},async()=>({verdict:"allow",reason:"😀".repeat(300000)})]) {
    await expect(evaluatePolicy(snapshot("closed"),delegate,{call})).rejects.toMatchObject({code:"not_allowed",message:"Policy decision failed"});
    expect((await evaluatePolicy(snapshot(),delegate,{call})).params).toEqual(delegate);
  }
});

test("outer deadline aborts an uncooperative call and never visits later policies",async()=>{
  let count=0; let signal:AbortSignal|undefined;
  const result=await evaluatePolicy(snapshot(),delegate,{deadline:Date.now()+20,call:async(_p,_params,options)=>{count++;signal=options.signal;await new Promise(()=>{});}});
  expect(count).toBe(1);
  expect(signal?.aborted).toBe(true);
  expect(result.params).toEqual(delegate);
});

test("policy calls share one ten-second deadline",async()=>{
  let clock=0;
  const visited:string[]=[];
  const source=freezePolicySnapshot({mode:"open",fingerprint:"aggregate",policies:["a","b","c","d"].map(id=>({id,generation:"1"}))});
  const receipt=await evaluatePolicy(source,delegate,{now:()=>clock,call:async(policy)=>{visited.push(policy.id);clock+=4000;return {verdict:"allow"};}});
  expect(visited).toEqual(["a","b","c"]);
  expect(()=>receipt.revalidate("aggregate")).not.toThrow();
});

test("cancellation stops evaluation even in open mode",async()=>{
  const controller=new AbortController();
  await expect(evaluatePolicy(snapshot(),delegate,{signal:controller.signal,call:async()=>{controller.abort();return {verdict:"amend",amend:{kind:"tests"}};}})).rejects.toMatchObject({code:"not_allowed"});
});

test("placement eligibility rejects invalid amendment and snapshots cannot be mutated",async()=>{
  const source={mode:"closed" as const,fingerprint:"g",policies:[{id:"a",generation:"1"}]};
  const frozen=freezePolicySnapshot(source); source.mode="open" as "closed";source.policies.length=0;
  expect(frozen.mode).toBe("closed");expect(frozen.policies.length).toBe(1);
  await expect(evaluatePolicy(frozen,delegate,{allowedPlacements:["new"],call:async()=>({verdict:"amend",amend:{placement:"current"}})})).rejects.toMatchObject({code:"not_allowed"});
});


test("missing placement eligibility and duplicate identities cannot authorize decisions",async()=>{
  await expect(evaluatePolicy(snapshot("closed"),delegate,{call:async()=>({verdict:"amend",amend:{placement:"new"}})})).rejects.toMatchObject({code:"not_allowed"});
  expect(()=>freezePolicySnapshot({mode:"open",fingerprint:"g",policies:[{id:"a",generation:"1"},{id:"a",generation:"2"}]})).toThrow("identity");
});

test("activity callback failure cannot suppress explicit veto",async()=>{
  await expect(evaluatePolicy(snapshot(),delegate,{call:async()=>({verdict:"veto",reason:"no"}),onVeto:()=>{throw Error("sink");}})).rejects.toMatchObject({code:"not_allowed",message:"no",hint:"plugin a"});
});

test("delegate project eligibility is checked cumulatively",async()=>{
  await expect(evaluatePolicy(snapshot("closed"),delegate,{eligibleRunnerIds:["runner"],validateDelegate:()=>false,call:async()=>({verdict:"amend",amend:{requestedExecutor:"runner"}})})).rejects.toMatchObject({code:"not_allowed"});
});

test("oversized candidate input obeys mode without trimming candidates",async()=>{
  const candidates=Array.from({length:10000},(_,i)=>`${i}`.padEnd(128,"x"));
  const params={decision:"route" as const,input:{taskId:"task",candidates}};
  let calls=0;
  const call=async()=>{calls++;return {verdict:"allow"};};
  expect((await evaluatePolicy(snapshot(),params,{call})).params).toEqual(params);
  await expect(evaluatePolicy(snapshot("closed"),params,{call})).rejects.toMatchObject({code:"not_allowed",message:"Policy decision failed"});
  expect(calls).toBe(0);
});

test("effective amendments require complete eligibility validation in both modes",async()=>{
  for(const amend of [{kind:"tests"},{requestedExecutor:"runner"},{placement:"new"}]) {
    const options={eligibleRunnerIds:["runner"],allowedPlacements:["new" as const],call:async()=>({verdict:"amend",amend})};
    expect((await evaluatePolicy(snapshot(),delegate,options)).params).toEqual(delegate);
    await expect(evaluatePolicy(snapshot("closed"),delegate,options)).rejects.toMatchObject({code:"not_allowed"});
  }
});

test("individually eligible fields cannot bypass project placement combination checks",async()=>{
  const options={eligibleRunnerIds:["runner"],allowedPlacements:["new" as const],validateDelegate:(input:{requestedExecutor:string|null;placement:string})=>!(input.requestedExecutor==="runner"&&input.placement==="new"),call:async()=>({verdict:"amend",amend:{requestedExecutor:"runner",placement:"new"}})};
  expect((await evaluatePolicy(snapshot(),delegate,options)).params).toEqual(delegate);
  await expect(evaluatePolicy(snapshot("closed"),delegate,options)).rejects.toMatchObject({code:"not_allowed"});
});

test("abort before the call microtask prevents dispatch",async()=>{
  const controller=new AbortController();
  let calls=0;
  const evaluation=evaluatePolicy(snapshot(),delegate,{signal:controller.signal,call:async()=>{calls++;return {verdict:"allow"};}});
  controller.abort();
  await expect(evaluation).rejects.toMatchObject({code:"not_allowed"});
  expect(calls).toBe(0);
});
