import { afterEach, expect, test } from "bun:test";
import {consoleOpener} from "../src/serve/console-open";
import { startServer } from "../src/serve/http";
import { fakeCtx } from "./helpers";
import { fakeRun, raw } from "./fixtures/orca/fake";
import { readOutboxSince, writeConsole } from "../src/link/store";
const reply=(result:unknown)=>raw(JSON.stringify({ok:true,result}));
const stops:(()=>void)[]=[];
afterEach(()=>stops.splice(0).forEach(stop=>stop()));
function fixture(show=true) {
 const f=fakeRun([
 [["orca","terminal","show"],show?reply({terminal:{worktreeId:"wt",worktreeDisplayName:"Feature"}}):raw("",1)],
 [["orca","worktree","show"],reply({worktree:{id:"wt",displayName:"Feature"}})],
 [["orca","terminal","list"],reply({terminals:[{handle:"term_existing"}]})],
 [["orca","terminal","create"],reply({terminal:{handle:"term_new"}})],
 ]);
 const ctx=fakeCtx({run:f.run,env:{PACER_BIN:"/opt/pacer's bin"}});
 const server=startServer(()=>ctx,{port:0,pumpMs:0});stops.push(server.stop);
 const url=`http://127.0.0.1:${server.port}`;
 const opener=consoleOpener(ctx.now);
 const httpPost=(body:unknown={terminal:"term_existing",branch:"feat/x"},headers:Record<string,string>={},method="POST",path="/console/open")=>fetch(url+path,{method,headers:{authorization:`Bearer ${server.token}`,"content-type":"application/json",...headers},...(method==="GET"?{}:{body:typeof body==="string"?body:JSON.stringify(body)})});
 const post=(body:unknown={terminal:"term_existing",branch:"feat/x"},headers:Record<string,string>={},method="POST",path="/console/open")=>opener(new Request(url+path,{method,headers:{"content-type":"application/json",...headers},body:typeof body==="string"?body:JSON.stringify(body)}),ctx);
 return {f,ctx,post,httpPost};
}
test("console POST authenticates, validates methods, media type, size and selectors",async()=>{
 const {httpPost:post,f}=fixture();
 expect((await post({}, {authorization:"bad"})).status).toBe(401);
 expect((await post({}, {},"PUT")).status).toBe(405);
 expect((await post({}, {},"POST","/other")).status).toBe(405);
 expect((await post({}, {},"GET")).status).toBe(404);
 expect((await post({}, {"content-type":"text/plain"})).status).toBe(415);
 expect((await post(" ".repeat(4097))).status).toBe(413);
 for(const body of ["{",[],null,{}, {terminal:"term_;evil"},{terminal:"term_"},{branch:"x;echo"},{branch:"x".repeat(201)},{terminal:"term_x",branch:7}])expect((await post(body)).status).toBe(400);
 expect(f.calls).toHaveLength(0);
});
test("handle resolves preferred worktree, creates constant quoted command without focus and alerts",async()=>{
 const {post,f,ctx}=fixture();expect(await (await post()).json()).toEqual({ok:true,handle:"term_new"});
 expect(f.calls).toEqual([
 ["orca","terminal","show","--terminal","term_existing","--json"],
 ["orca","terminal","list","--worktree","id:wt","--json"],
 ["orca","terminal","create","--worktree","id:wt","--title","pacer","--command","'/opt/pacer'\\''s bin' console","--json"],
 ]);
 expect(readOutboxSince(ctx,0)[0].envelope).toMatchObject({type:"alert",data:{level:"info",title:"Opened pacer console in Feature"}});
});
test("branch fallback uses branch selector and canonical id and shares rate limit with handle requests",async()=>{
 const {post,f}=fixture(false);expect((await post()).status).toBe(200);
 expect(f.calls[1]).toEqual(["orca","worktree","show","--worktree","branch:feat/x","--json"]);
 expect(f.calls[3][4]).toBe("branch:feat/x");
 expect(await (await post({branch:"feat/x"})).json()).toMatchObject({ok:false,reason:"rate-limited"});
});
test("live worktree console refuses open; stale console permits it",async()=>{
 const {post,ctx,f}=fixture();writeConsole(ctx,{handle:"term_existing",pid:process.pid,paneKey:null,startedAt:ctx.now,heartbeatAt:ctx.now-30});
 expect(await (await post()).json()).toMatchObject({ok:false,reason:"console-present"});expect(f.count(["orca","terminal","create"])).toBe(0);
 ctx.now++;expect(await (await post()).json()).toMatchObject({ok:true});
});
test("60 second worktree and rolling global hourly limits",async()=>{
 const {post,ctx,f}=fixture();expect((await (await post()).json()).ok).toBe(true);
 ctx.now+=59;expect((await (await post()).json()).reason).toBe("rate-limited");
 for(let i=1;i<10;i++){ctx.now+=60;expect((await (await post()).json()).ok).toBe(true);}
 ctx.now+=60;expect((await (await post()).json()).reason).toBe("rate-limited");expect(f.count(["orca","terminal","create"])).toBe(10);
 ctx.now+=3600;expect((await (await post()).json()).ok).toBe(true);
});

test("concurrent requests reserve one open before creation yields",async()=>{
 const {post,f}=fixture();const results=await Promise.all([post(),post()]);
 expect((await Promise.all(results.map(r=>r.json()))).filter(r=>r.ok)).toHaveLength(1);
 expect(f.count(["orca","terminal","create"])).toBe(1);
});
test("global hourly cap applies across distinct worktrees",async()=>{
 const f=fakeRun([
 [["orca","worktree","show"],argv=>reply({worktree:{id:argv[4],displayName:argv[4]}})],
 [["orca","terminal","list"],reply({terminals:[]})],
 [["orca","terminal","create"],reply({terminal:{handle:"term_new"}})],
 ]);
 const ctx=fakeCtx({run:f.run});const open=consoleOpener(ctx.now);
 for(let i=0;i<11;i++){
  const r=await open(new Request("http://127.0.0.1/console/open",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({branch:`feature-${i}`})}),ctx);
  expect(await r.json()).toMatchObject(i<10?{ok:true}:{ok:false,reason:"rate-limited"});
 }
 expect(f.count(["orca","terminal","create"])).toBe(10);
});
test("unresolved worktree or failed terminal listing never creates a console",async()=>{
 const {post,f,ctx}=fixture(false);ctx.run=fakeRun([]).run;
 expect(await (await post({terminal:"term_missing"})).json()).toMatchObject({ok:false});
 expect(await (await post({branch:"missing"})).json()).toMatchObject({ok:false});expect(f.calls).toHaveLength(0);
});
for (const terminal of [{handle:"term_dead",title:"pacer"},{handle:"term_dead",title:"pacer",startedAt:9999999999}]) test("unknown or newly started pacer terminals refuse duplicate creation "+JSON.stringify(terminal),async()=>{
 const {post,ctx}=fixture(); const f=fakeRun([
 [["orca","terminal","show"],reply({terminal:{worktreeId:"wt",worktreeDisplayName:"Feature"}})],
 [["orca","terminal","list"],reply({terminals:[terminal]})],
 [["orca","terminal","create"],reply({terminal:{handle:"term_duplicate"}})],
 ]);ctx.run=f.run;
 expect(await (await post()).json()).toMatchObject({ok:false,reason:"console-terminal-exists"});expect(f.count(["orca","terminal","create"])).toBe(0);
});
for(const evidence of ["old-start","legacy","old-version","current-version"] as const)test("existing console replacement requires old evidence and is hourly bounded: "+evidence,async()=>{
 const {post,ctx}=fixture();
 const f=fakeRun([
 [["orca","terminal","show"],reply({terminal:{worktreeId:"wt",worktreeDisplayName:"Feature"}})],
 [["orca","terminal","list"],reply({terminals:[{handle:"term_old",title:"pacer",...(evidence==="old-start"?{startedAt:ctx.now-1}:{})}]})],
 [["orca","terminal","create"],reply({terminal:{handle:"term_replacement"}})],
 ]);ctx.run=f.run;
 if(evidence!=="old-start")writeConsole(ctx,{handle:"term_old",pid:process.pid,paneKey:null,startedAt:ctx.now-100,heartbeatAt:ctx.now-31,...(evidence==="legacy"?{}:{version:evidence==="old-version"?"0.1.7":"0.1.8"})});
 expect(await (await post()).json()).toMatchObject(evidence==="current-version"?{ok:false,reason:"console-terminal-exists"}:{ok:true,warning:"older-console"});
 if(evidence==="current-version"){expect(f.count(["orca","terminal","create"])).toBe(0);return;}
 ctx.now+=61;expect(await (await post()).json()).toMatchObject({ok:false,reason:"console-terminal-exists"});expect(f.count(["orca","terminal","create"])).toBe(1);
 ctx.now+=3600;expect(await (await post()).json()).toMatchObject({ok:true});
});
test("a newly opened console never qualifies for replacement even if its title changes",async()=>{
 const {post,ctx}=fixture();expect((await (await post()).json()).ok).toBe(true);ctx.now+=61;
 ctx.run=fakeRun([
 [["orca","terminal","show"],reply({terminal:{worktreeId:"wt",worktreeDisplayName:"Feature"}})],
 [["orca","terminal","list"],reply({terminals:[{handle:"term_new",title:"renamed",startedAt:1}]})],
 ]).run;
 expect(await (await post()).json()).toMatchObject({ok:false,reason:"console-terminal-exists"});
});
test("failed terminal create releases worktree and global reservations",async()=>{
 const {post,ctx}=fixture();let attempts=0;
 const f=fakeRun([
 [["orca","terminal","show"],reply({terminal:{worktreeId:"wt",worktreeDisplayName:"Feature"}})],
 [["orca","terminal","list"],reply({terminals:[]})],
 [["orca","terminal","create"],()=>{if(++attempts<=11)throw Error("create failed");return reply({terminal:{handle:"term_recovered"}});}],
 ]);ctx.run=f.run;
 for(let i=0;i<11;i++)expect(await (await post()).json()).toMatchObject({ok:false,reason:"orca-unavailable"});
 expect(await (await post()).json()).toMatchObject({ok:true,handle:"term_recovered"});
});

test("console forget is token-gated, validates bounded JSON and removes only matching worktree registrations and reservations", async () => {
 const {post,httpPost,ctx,f}=fixture();
 expect((await (await post()).json()).ok).toBe(true);
 writeConsole(ctx,{worktreeId:"wt",handle:"term_gone",pid:process.pid,paneKey:null,startedAt:ctx.now,heartbeatAt:ctx.now});
 writeConsole(ctx,{worktreeId:"other",handle:"term_kept",pid:process.pid,paneKey:null,startedAt:ctx.now,heartbeatAt:ctx.now});
 expect((await httpPost({worktreeId:"wt"},{authorization:"bad"},"POST","/console/forget")).status).toBe(401);
 for(const body of [{}, {worktreeId:"../bad"}, {worktreeId:123}, "{", " ".repeat(4097)]) expect((await post(body,{},"POST","/console/forget")).status).toBe(body === " ".repeat(4097) ? 413 : 400);
 expect(await (await post({worktreeId:"wt"},{},"POST","/console/forget")).json()).toEqual({ok:true});
 const {readConsoles}=await import("../src/link/store"); expect(readConsoles(ctx).map(c=>c.handle)).toEqual(["term_kept"]);
 expect((await (await post()).json()).ok).toBe(true);expect(f.count(["orca","terminal","create"])).toBe(2);
});

test("forget accepts Orca composite worktree identity",async()=>{
 const {post}=fixture();expect(await (await post({worktreeId:"abc-123::/Users/name/My Repo"},{},"POST","/console/forget")).json()).toEqual({ok:true});
});

test("hourly legacy replacement reservation survives serve restart and forget",async()=>{
 const {post,ctx}=fixture();const f=fakeRun([
 [["orca","terminal","show"],reply({terminal:{worktreeId:"wt",worktreeDisplayName:"Feature"}})],
 [["orca","terminal","list"],reply({terminals:[{handle:"term_old",title:"pacer",startedAt:ctx.now-1}]})],
 [["orca","terminal","create"],reply({terminal:{handle:"term_replacement"}})],
 ]);ctx.run=f.run;expect(await (await post()).json()).toMatchObject({ok:true});
 expect(await (await post({worktreeId:"wt"},{},"POST","/console/forget")).json()).toEqual({ok:true});ctx.now+=61;
 const {consoleOpener}=await import("../src/serve/console-open");const newOpener=consoleOpener(ctx.now);
 const req=()=>new Request("http://localhost/console/open",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({terminal:"term_existing"})});
 expect(await (await newOpener(req(),ctx)).json()).toMatchObject({ok:false,reason:"console-terminal-exists"});expect(f.count(["orca","terminal","create"])).toBe(1);
 ctx.now+=3600;expect(await (await newOpener(req(),ctx)).json()).toMatchObject({ok:true});
});

test("failed replacement rollback preserves another worktree's concurrent hourly reservation",async()=>{
 const {consoleOpener}=await import("../src/serve/console-open");
 let failed!:()=>void,entered!:()=>void;const started=new Promise<void>(r=>entered=r);const blocked=new Promise<void>(r=>failed=r);
 const f=fakeRun([
 [["orca","worktree","show"],a=>reply({worktree:{id:a[4].slice(7),displayName:a[4]}})],
 [["orca","terminal","list"],a=>reply({terminals:[{handle:`term_old_${a[4].slice(7)}`,title:"pacer",startedAt:1}]})],
 [["orca","terminal","create"],reply({terminal:{handle:"term_new_b"}})],
 ]);const ctx=fakeCtx({run:async(a,ms)=>{if(a[2]==="create" && a[4]==="branch:a"){entered();await blocked;return raw("",1);}return f.run(a,ms);}});const opener=consoleOpener(ctx.now);
 const req=(branch:string)=>new Request("http://localhost/console/open",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({branch})});
 const a=opener(req("a"),ctx);await started;expect(await (await opener(req("b"),ctx)).json()).toMatchObject({ok:true});failed();expect(await (await a).json()).toMatchObject({ok:false});
 ctx.now+=61;expect(await (await consoleOpener(ctx.now)(req("b"),ctx)).json()).toMatchObject({ok:false,reason:"console-terminal-exists"});
});
