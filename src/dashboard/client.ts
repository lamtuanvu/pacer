import { readFileSync } from "node:fs";
import { join } from "node:path";
import { connectClient, ApiError, type ApiClient } from "../api/client";
import { callOp } from "../api/ops";
import { liveSnapshot } from "../api/events";
import { helloBody } from "../api/protocol";
import { emptySnapshot } from "../link/envelope";
import { localHuman } from "../messaging/participants";
import type { Ctx } from "../types";

/** The dashboard consumes v3; the shared legacy clients retain their v2 contract. */
export async function dashboardClient(ctx:Ctx, local=false):Promise<ApiClient> {
 const legacy=await connectClient({...ctx,env:{...ctx.env,...(local?{PACER_API:"inprocess"}:{})}});
 const remote=legacy.kind==="http",controller=new AbortController();
 const base=`http://127.0.0.1:${ctx.env.PACER_PORT??4317}/v3`;
 const token=remote?readFileSync(join(ctx.pacerHome,"token"),"utf8").trim():"";
 const fresh=()=>({...ctx,now:Date.now()/1000});
 // The person at this terminal is the human over HTTP too, as in process: exchange the bearer for an app
 // session once and present it on operations. Planner and executor sessions never ask (see localHuman).
 let human:Promise<string|null>|undefined;
 const humanSession=()=>{
  if(!remote||localHuman(ctx)!=="human")return Promise.resolve(null);
  return human??=fetch(`${base}/session/exchange`,{method:"POST",signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)]),headers:{authorization:`Bearer ${token}`}})
   .then(response=>/(?:^|[;,]\s*)pacer_session=([0-9a-f]{64})/.exec(response.ok?response.headers.get("set-cookie")??"":"")?.[1]??null).catch(()=>null)
   // A failed exchange is retried on the next operation rather than leaving the session non-human.
   .then(value=>{if(!value)human=undefined;return value;});
 };
 async function request(path:string,params?:unknown) {
  const session=params===undefined?null:await humanSession();
  const response=await fetch(`${base}/${path}`,{method:params===undefined?"GET":"POST",signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)]),headers:{authorization:`Bearer ${token}`,"content-type":"application/json",...(session?{"x-pacer-session":session}:{})},...(params===undefined?{}:{body:JSON.stringify(params)})});
  if(!response.ok){const body=await response.json() as {error?:{code:ConstructorParameters<typeof ApiError>[0];message:string;hint?:string}};throw new ApiError(body.error?.code??"internal",body.error?.message??`HTTP ${response.status}`,body.error?.hint);}
  return response.json();
 }
 return {
  kind:legacy.kind,
  hello:()=>remote?request("hello"):Promise.resolve(helloBody()),
  snapshot:async()=>{const result=remote?await request("snapshot"):await liveSnapshot(fresh());return {...result,snapshot:{...emptySnapshot(),...result.snapshot}};},
  call:async<T>(op:string,params?:unknown):Promise<T>=>remote?(await request(`ops/${encodeURIComponent(op)}`,params??{})).result:callOp(fresh(),op,params??{},{participant:localHuman(ctx)}) as Promise<T>,
  // Refreshes are also polled; legacy events remain useful wake-ups during the overlap.
  subscribe:(_since,onEvent)=>legacy.subscribe(0,onEvent),
  close(){controller.abort();legacy.close();}
 };
}
