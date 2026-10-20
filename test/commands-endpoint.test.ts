import {expect, test} from "bun:test";
import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {accountCmd, runnerCmd, type AccountDeps} from "../src/commands/accounts";
import {loadStrategy} from "../src/config/strategy";
import {computeStatus} from "../src/engine/status";
import {fakeCtx} from "./helpers";

const secret = "sk-endpoint-cli-private-value";
function setup() {
  let stored: string | null=null;
  const ctx = fakeCtx({run:async (argv,_timeout,options)=>{
    if (argv[0]!=='security') return {code:127,stdout:'',stderr:''};
    if (argv[1]==='-i') stored=Buffer.from(options!.stdin!.match(/-X ([0-9a-f]+)/)![1],'hex').toString();
    if (argv[1]==='delete-generic-password') stored=null;
    return {code:argv[1]==='find-generic-password' && !stored?44:0,stdout:argv.includes('-w')?stored ?? '':'',stderr:''};
  }});
  ctx.env = {HOME: ctx.home, PACER_HOME: ctx.pacerHome, PATH: process.env.PATH};
  mkdirSync(ctx.pacerHome, {recursive:true});
  writeFileSync(join(ctx.pacerHome,"strategy.yaml"), '# preserve this\naccounts:\n  personal: {kind: claude}\n  codex: {kind: codex}\nplanner: claude-code\nrouting:\n  - default: [codex]\n');
  return ctx;
}
function script(answers: string[], overrides: AccountDeps = {}) {
  const questions: string[] = [], printed: string[] = [];
  const deps: AccountDeps = {prompt: async q => {questions.push(q); if (!answers.length) throw Error(`unexpected prompt: ${q}`); return answers.shift()!;},
    promptSecret: async () => secret, print: line => {printed.push(line);},
    spawn: async spec => {writeFileSync(join(spec.cwd,"hello.txt"), "ok"); return {code:0,stdout:"",stderr:"",timedOut:false};}, ...overrides};
  return {deps, questions, printed};
}
function noLeaks(ctx: ReturnType<typeof setup>, result: {out:string;err:string}, printed: string[] = []) {
  for (const text of [result.out,result.err,...printed,readFileSync(join(ctx.pacerHome,"strategy.yaml"),"utf8"),
    existsSync(join(ctx.pacerHome,"opencode/opencode.json")) ? readFileSync(join(ctx.pacerHome,"opencode/opencode.json"),"utf8") : ""])
    expect(text).not.toContain(secret);
  if (existsSync(join(ctx.pacerHome,'endpoints/state.json'))) expect(readFileSync(join(ctx.pacerHome,'endpoints/state.json'),'utf8')).not.toContain(secret);
}
function server(status: number | number[] = 200) {
  let requestCount=0;
  return Bun.serve({hostname:"127.0.0.1",port:0,fetch: request => {
    expect(request.headers.get("authorization")).toBe(`Bearer ${secret}`);
    return Response.json({data:[{id:"model-a",context_length:262144,max_output_tokens:32768}]},{status:Array.isArray(status)?status[Math.min(requestCount++,status.length-1)]:status});
  }});
}
for (const transport of ['injected','server']) test(`interactive endpoint add reaches Ready (${transport})`, async () => {
  const ctx=setup(), api=transport==='server'?server():null;
  try {
    const s=script(["3","work",api?.url.toString() ?? "http://test.invalid/v1","","1","unmetered","y"],api?{}:{fetch:async()=>Response.json({data:[{id:"model-a",context_length:262144,max_output_tokens:32768}]})});
    const result=await accountCmd(["add"],ctx,s.deps);
    expect(result.code).toBe(0); expect(result.out).toContain("Ready: opencode#work");
    expect(loadStrategy(ctx).runners["opencode#work"].model).toBe("pacer-work/model-a");
    expect(loadStrategy(ctx).routing.at(-1)!.executors).toEqual(["codex","opencode#work"]);
    expect(readFileSync(join(ctx.pacerHome,"strategy.yaml"),"utf8")).toContain("# preserve this");
    noLeaks(ctx,result,s.printed);
  } finally {api?.stop(true);}
});
for (const transport of ['injected','server']) test(`401 re-asks for a hidden key before saving (${transport})`,async()=>{
  const ctx=setup(),api=transport==='server'?server([401,200]):null; let attempts=0, prompts=0;
  try {
  const s=script(["endpoint","work",api?.url.toString() ?? "https://test.invalid/v1","","1","unmetered","n"],{
    promptSecret:async()=>{prompts++; return secret;},
    ...(api?{}:{fetch:async()=>{attempts++;return Response.json({data:[{id:"m",context_length:100,max_output_tokens:50}]},{status:attempts===1?401:200});}}),
  });
  const result=await accountCmd(["add"],ctx,s.deps);
  expect(result.code).toBe(0);expect(prompts).toBe(2);expect(s.printed.join("\n")).toContain("The key was refused.");noLeaks(ctx,result,s.printed);
  }finally{api?.stop(true);}
});
for (const transport of ['injected','server']) test(`missing models supports manual ids (${transport})`,async()=>{
  const ctx=setup(),api=transport==='server'?server(404):null;
  try {
    const s=script(["endpoint","work",api?.url.toString() ?? "http://test.invalid/v1","","manual-a,manual-b","128K","16K","unmetered","n"],api?{}:{fetch:async()=>new Response('',{status:404})});
    const result=await accountCmd(["add"],ctx,s.deps);
    expect(result.code).toBe(0);expect(result.out).toContain("Not tested");
    expect(loadStrategy(ctx).accounts.work.connection!.models).toEqual(["manual-a","manual-b"].map(id=>({id,context:128000,output:16000,tools:true})));
    noLeaks(ctx,result,s.printed);
  }finally{api?.stop(true);}
});
test("failed endpoint test persists Not working and routing excludes it",async()=>{
  const ctx=setup();const s=script([], {readStdin:async()=>secret,spawn:async()=>({code:1,stdout:"",stderr:`Authorization: Bearer ${secret}`,timedOut:false})});
  const result=await accountCmd(["add","endpoint","work","--base-url","http://localhost/v1","--key","file","--models","m","--usage","unmetered"],ctx,s.deps);
  expect(result.code).toBe(0);expect(result.out).toContain("Not working");expect(result.out).toContain("pacer account test work");
  const status=await computeStatus(ctx,loadStrategy(ctx));
  expect(status.executors.ranked.some(r=>r.id==='opencode#work')).toBe(false);
  expect(status.executors.excluded.find(r=>r.id==='opencode#work')?.reason).toContain('Not working');noLeaks(ctx,result,s.printed);
});
test("name collision offers edit and saves no bytes",async()=>{
  const ctx=setup(),path=join(ctx.pacerHome,"strategy.yaml"),before=readFileSync(path,"utf8");
  const result=await accountCmd(["add","endpoint","codex","--base-url","http://localhost","--key","file","--models","m","--usage","unmetered"],ctx,{readStdin:async()=>{throw Error("must not read");}});
  expect(result.err).toContain("pacer account edit codex");expect(readFileSync(path,"utf8")).toBe(before);noLeaks(ctx,result);
});
test("explicit no-test, models, edit, test and removal manage config and keys",async()=>{
  const ctx=setup(), s=script([],{readStdin:async()=>secret});
  const result=await accountCmd(["add","endpoint","work","--base-url","http://localhost/v1","--key","file","--models","m","--usage","unmetered","--no-test"],ctx,s.deps);
  expect(result.code).toBe(0);expect(result.out).toContain("Not tested");noLeaks(ctx,result);
  expect((await accountCmd(["models","work"],ctx)).out).toContain("m");
  const edited=await accountCmd(["edit","work","--models","new","--usage","unmetered"],ctx,s.deps);
  expect(edited.code).toBe(0);expect(loadStrategy(ctx).runners['opencode#work'].model).toBe('pacer-work/new');noLeaks(ctx,edited);
  expect((await accountCmd(["test","work"],ctx,s.deps)).out).toContain("Ready");
  expect((await accountCmd(["rm","work","--delete-key"],ctx)).err).toContain("in use");
  expect((await runnerCmd(["rm","opencode#work"],ctx)).code).toBe(0);
  expect((await accountCmd(["rm","work","--delete-key"],ctx)).code).toBe(0);
  expect(existsSync(join(ctx.pacerHome,"secrets/work.key"))).toBe(false);
  expect(readFileSync(join(ctx.pacerHome,"opencode/opencode.json"),"utf8")).not.toContain('pacer-work');
});
test("refresh changes selected models and adopt projects only external provider metadata",async()=>{
  const ctx=setup();
  // Existing external endpoint, using a fixture under the isolated HOME.
  const {applyEdit}=await import('../src/core/accounts');
  applyEdit(ctx,doc=>doc.addMappingEntry('accounts','external',{kind:'endpoint',usage:'unmetered',model:'vendor/old'}));
  expect((await runnerCmd(['add','opencode#external'],ctx)).code).toBe(0);
  mkdirSync(join(ctx.home,'.config/opencode'),{recursive:true});
  const config=join(ctx.home,'.config/opencode/opencode.json');
  const original=JSON.stringify({provider:{vendor:{options:{baseURL:'http://localhost/v1',apiKey:secret},models:{old:{limit:{context:8192,output:1024}}}}}});
  writeFileSync(config,original);
  const s=script(['y','none','unmetered','n']);
  const adopted=await accountCmd(['edit','external'],ctx,s.deps);
  expect(adopted.code).toBe(0);expect(readFileSync(config,'utf8')).toBe(original);noLeaks(ctx,adopted,s.printed);
  const refresh=script(['1'],{fetch:async()=>Response.json({data:[{id:'fresh',context_length:100,max_output_tokens:50}]})});
  const result=await accountCmd(['models','external','--refresh'],ctx,refresh.deps);
  expect(result.code).toBe(0);expect(loadStrategy(ctx).accounts.external.connection!.models[0].id).toBe('fresh');noLeaks(ctx,result,refresh.printed);
});

test("invalid and unreachable URLs re-ask before saving any account",async()=>{
  const ctx=setup();let requests=0, hidden=0;
  const s=script(['endpoint','work','file:///invalid','http://offline.invalid/v1','','http://working.invalid/v1','1','unmetered','n'],{
    promptSecret:async()=>{hidden++;return secret;},
    fetch:async()=>{
      requests++;
      expect(loadStrategy(ctx).accounts.work).toBeUndefined();
      if(requests===1) throw Error(`Authorization: Bearer ${secret}`);
      return Response.json({data:[{id:'m',context_length:100,max_output_tokens:50}]});
    },
  });
  const result=await accountCmd(['add'],ctx,s.deps);
  expect(result.code).toBe(0);expect(hidden).toBe(1);expect(requests).toBe(2);
  expect(s.printed.join('\n')).toContain('Check the URL and try again.');noLeaks(ctx,result,s.printed);
});
test("environment keys survive deletion and a missing env key is reported",async()=>{
  const ctx=setup();ctx.env.ENDPOINT_TOKEN=secret;
  const s=script([]);
  const added=await accountCmd(['add','endpoint','work','--base-url','http://localhost/v1','--key','env:ENDPOINT_TOKEN','--models','m','--usage','unmetered','--no-test'],ctx,s.deps);
  expect(added.code).toBe(0);noLeaks(ctx,added);
  const missing={...ctx,env:{}};
  const rows=JSON.parse((await accountCmd(['list','--json'],missing)).out);
  expect(rows.find((r:any)=>r.name==='work').state).toBe('key_missing');
  expect((await runnerCmd(['rm','opencode#work'],ctx)).code).toBe(0);
  let confirmed=false;
  expect((await accountCmd(['rm','work','--delete-key'],ctx,{confirm:async()=>{confirmed=true;return true;}})).code).toBe(0);
  expect(confirmed).toBe(false);expect(ctx.env.ENDPOINT_TOKEN).toBe(secret);
});
test("removal asks before deleting a stored key and preserves it on decline",async()=>{
  for (const answer of [false,true]) {
    const ctx=setup(),s=script([],{readStdin:async()=>secret});
    expect((await accountCmd(['add','endpoint','work','--base-url','http://localhost/v1','--key','file','--models','m','--usage','unmetered','--no-test'],ctx,s.deps)).code).toBe(0);
    expect((await runnerCmd(['rm','opencode#work'],ctx)).code).toBe(0);
    let asked=false;
    const result=await accountCmd(['rm','work'],ctx,{confirm:async()=>{asked=true;return answer;}});
    expect(result.code).toBe(0);expect(asked).toBe(true);
    expect(existsSync(join(ctx.pacerHome,'secrets/work.key'))).toBe(!answer);noLeaks(ctx,result);
  }
});
test("invalid endpoint input is validated before storing a key or changing config",async()=>{
  const ctx=setup(),path=join(ctx.pacerHome,'strategy.yaml'),before=readFileSync(path,'utf8');
  const result=await accountCmd(['add','endpoint','work','--base-url','file:///invalid','--key','file','--models','m','--usage','unmetered','--no-test'],ctx,{readStdin:async()=>secret});
  expect(result.code).not.toBe(0);expect(readFileSync(path,'utf8')).toBe(before);
  expect(existsSync(join(ctx.pacerHome,'secrets/work.key'))).toBe(false);noLeaks(ctx,result);
});
test("shared core operations return safe account data and use stored credentials for discovery",async()=>{
  const ctx=setup(), core=await import('../src/core/endpoints'),s=script([]);
  const added=await core.addEndpoint(ctx,{name:'work',base_url:'http://localhost/v1',key_source:'file',key:secret,
    models:[{id:'m',context:100,output:50,tools:true}],usage:'unmetered',test:false},s.deps);
  expect(added.state).toBe('not_tested');expect(added.account.connection?.key).toBe('present');
  expect(JSON.stringify(added)).not.toContain(secret);
  const discovery=await core.listModels(ctx,{name:'work'},{fetch:async(_url,init)=>{
    expect((init!.headers as Record<string,string>).Authorization).toBe(`Bearer ${secret}`);
    return Response.json({data:[{id:'fresh'}]});
  }});
  expect(discovery.listed).toBe(true);expect(JSON.stringify(discovery)).not.toContain(secret);
  const edited=await core.editEndpoint(ctx,{name:'work',models:[{id:'fresh',context:100,output:50,tools:true}]});
  expect(edited.runner.model).toBe('pacer-work/fresh');expect(JSON.stringify(edited)).not.toContain(secret);
  const state=await core.testEndpoint(ctx,'work',s.deps);expect(state.state).toBe('ready');
});
test("no-test reports Key missing when an env key is absent",async()=>{
  const ctx=setup();
  const result=await accountCmd(['add','endpoint','work','--base-url','http://localhost/v1','--key','env:ABSENT_TOKEN','--models','m','--usage','unmetered','--no-test'],ctx);
  expect(result.code).toBe(0);expect(result.out).toContain('Key missing');noLeaks(ctx,result);
});
test("editing usage preserves a selected account model and its runner",async()=>{
  const ctx=setup(),core=await import('../src/core/endpoints');
  await core.addEndpoint(ctx,{name:'work',base_url:'http://localhost/v1',key_source:'none',models:['a','b'].map(id=>({id,context:100,output:50,tools:true})),usage:'unmetered',test:false});
  const {applyEdit}=await import('../src/core/accounts');
  applyEdit(ctx,doc=>{doc.setIn(['accounts','work','model'],'b');doc.removeMappingEntry('runners','opencode#work');});
  expect(loadStrategy(ctx).runners['opencode#work'].model).toBe('pacer-work/b');
  await core.editEndpoint(ctx,{name:'work',usage:'metered',weekly_tokens:1000000});
  expect(loadStrategy(ctx).runners['opencode#work'].model).toBe('pacer-work/b');
});
test("connection accounts reject usage outside quota, metered and unmetered",async()=>{
  const ctx=setup(),path=join(ctx.pacerHome,'strategy.yaml'),before=readFileSync(path,'utf8');
  const result=await accountCmd(['add','endpoint','work','--base-url','http://localhost/v1','--key','none','--models','m','--usage','reactive','--no-test'],ctx);
  expect(result.code).not.toBe(0);expect(readFileSync(path,'utf8')).toBe(before);noLeaks(ctx,result);
});
test("exhausted scripted endpoint input cancels without saving",async()=>{
  const ctx=setup(),answers=['endpoint','work'];
  const result=await accountCmd(['add'],ctx,{prompt:async()=>answers.shift()!,print:()=>{}});
  expect(result.code).not.toBe(0);expect(result.err).toContain('cancelled');
  expect(loadStrategy(ctx).accounts.work).toBeUndefined();noLeaks(ctx,result);
});
test.skipIf(!Bun.which('python3'))("real terminal key entry does not echo the secret",async()=>{
  const ctx=setup();
  const childCode=`import {accountCmd} from ${JSON.stringify(join(import.meta.dir,'../src/commands/accounts.ts'))};
let stored='';const ctx={home:process.env.HOME,pacerHome:process.env.PACER_HOME,now:1,env:{HOME:process.env.HOME},which:()=>null,
run:async(argv,t,o)=>{if(argv[1]==='-i') stored=Buffer.from(o.stdin.match(/-X ([0-9a-f]+)/)[1],'hex').toString();return {code:0,stdout:argv.includes('-w')?stored:'',stderr:''};}};
const result=await accountCmd(['add'],ctx,{fetch:async()=>Response.json({data:[{id:'m',context_length:100,max_output_tokens:50}]})});console.log(JSON.stringify(result));`;
  const python=`import os,pty,select,subprocess,sys,time
master,slave=pty.openpty()
proc=subprocess.Popen(['bun','-e',sys.argv[1]],stdin=slave,stdout=slave,stderr=slave,close_fds=True)
os.close(slave)
output=b''
try:
 for answer in ['endpoint','terminal-api','http://test.invalid/v1','','${secret}','1','unmetered','n']:
  marker=len(output);deadline=time.time()+3
  while b'> ' not in output[marker:]:
   if time.time()>deadline:raise RuntimeError('terminal prompt timed out')
   if select.select([master],[],[],0.1)[0]:output+=os.read(master,65536)
  os.write(master,(answer+'\\n').encode())
 deadline=time.time()+3
 while proc.poll() is None:
  if time.time()>deadline:raise RuntimeError('terminal exit timed out')
  if select.select([master],[],[],0.1)[0]:
   try:output+=os.read(master,65536)
   except OSError:break
 proc.wait(timeout=3)
 assert b'${secret}' not in output, 'hidden key echoed'
 assert b'Not tested: opencode#terminal-api' in output, 'terminal flow did not complete'
finally:
 if proc.poll() is None:proc.kill();proc.wait()
 os.close(master)
`;
  const child=Bun.spawn(['python3','-c',python,childCode],{env:{HOME:ctx.home,PACER_HOME:ctx.pacerHome,PATH:process.env.PATH},stdout:'pipe',stderr:'pipe'});
  const [code,err]=await Promise.all([child.exited,new Response(child.stderr).text()]);
  expect(err).toBe('');expect(code).toBe(0);
},15000);
