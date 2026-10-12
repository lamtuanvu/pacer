import { afterEach, expect, test } from "bun:test";
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
 const post=(body:unknown={terminal:"term_existing",branch:"feat/x"},headers:Record<string,string>={},method="POST",path="/console/open")=>fetch(url+path,{method,headers:{authorization:`Bearer ${server.token}`,"content-type":"application/json",...headers},...(method==="GET"?{}:{body:typeof body==="string"?body:JSON.stringify(body)})});
 return {f,ctx,post};
}
test("console POST authenticates, validates methods, media type, size and selectors",async()=>{
 const {post,f}=fixture();
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
 const ctx=fakeCtx({run:f.run});const server=startServer(()=>ctx,{port:0,pumpMs:0});stops.push(server.stop);
 for(let i=0;i<11;i++){
  const r=await fetch(`http://127.0.0.1:${server.port}/console/open`,{method:"POST",headers:{authorization:`Bearer ${server.token}`,"content-type":"application/json"},body:JSON.stringify({branch:`feature-${i}`})});
  expect(await r.json()).toMatchObject(i<10?{ok:true}:{ok:false,reason:"rate-limited"});
 }
 expect(f.count(["orca","terminal","create"])).toBe(10);
});
test("unresolved worktree or failed terminal listing never creates a console",async()=>{
 const {post,f,ctx}=fixture(false);ctx.run=fakeRun([]).run;
 expect(await (await post({terminal:"term_missing"})).json()).toMatchObject({ok:false});
 expect(await (await post({branch:"missing"})).json()).toMatchObject({ok:false});expect(f.calls).toHaveLength(0);
});
