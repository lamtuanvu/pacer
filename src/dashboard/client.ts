import { readFileSync } from "node:fs";
import { join } from "node:path";
import { connectClient, ApiError, type ApiClient } from "../api/client";
import { callOp } from "../api/ops";
import { liveSnapshot } from "../api/events";
import { helloBody } from "../api/protocol";
import { emptySnapshot } from "../link/envelope";
import type { Ctx } from "../types";

/** The dashboard consumes v3; the shared legacy clients retain their v2 contract. */
export async function dashboardClient(ctx:Ctx, local=false):Promise<ApiClient> {
 const legacy=await connectClient({...ctx,env:{...ctx.env,...(local?{PACER_API:"inprocess"}:{})}});
 const remote=legacy.kind==="http",controller=new AbortController();
 const base=`http://127.0.0.1:${ctx.env.PACER_PORT??4317}/v3`;
 const token=remote?readFileSync(join(ctx.pacerHome,"token"),"utf8").trim():"";
 const fresh=()=>({...ctx,now:Date.now()/1000});
 async function request(path:string,params?:unknown) {
  const response=await fetch(`${base}/${path}`,{method:params===undefined?"GET":"POST",signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)]),headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},...(params===undefined?{}:{body:JSON.stringify(params)})});
  if(!response.ok){const body=await response.json() as {error?:{code:ConstructorParameters<typeof ApiError>[0];message:string;hint?:string}};throw new ApiError(body.error?.code??"internal",body.error?.message??`HTTP ${response.status}`,body.error?.hint);}
  return response.json();
 }
 return {
  kind:legacy.kind,
  hello:()=>remote?request("hello"):Promise.resolve(helloBody()),
  snapshot:async()=>{const result=remote?await request("snapshot"):await liveSnapshot(fresh());return {...result,snapshot:{...emptySnapshot(),...result.snapshot}};},
  call:async<T>(op:string,params?:unknown):Promise<T>=>remote?(await request(`ops/${encodeURIComponent(op)}`,params??{})).result:callOp(fresh(),op,params??{}) as Promise<T>,
  // Refreshes are also polled; legacy events remain useful wake-ups during the overlap.
  subscribe:(_since,onEvent)=>legacy.subscribe(0,onEvent),
  close(){controller.abort();legacy.close();}
 };
}
