import { withLock } from "../core/lock";
import { writeJsonAtomic } from "../fsutil";
import type { Ctx } from "../types";
import { type OutboxEvent, reduce } from "./envelope";
import { latestPath } from "./paths";
import { type OutboxEntry, appendOutbox, notifyOutbox, readLatest, readOutboxSince, rotateOutbox } from "./store";
export interface PublishReport { seq:number; transports:"outbox"[]; errors:string[] }
/** Persist durable events. Never throws or sends to Orca. Events given as a function are read under the lock, so the last writer publishes the latest state. */
export async function publish(ctx:Ctx,given:OutboxEvent[]|(()=>OutboxEvent[])):Promise<PublishReport> {
 const report:PublishReport={seq:0,transports:[],errors:[]};
 try {
  await withLock(ctx,"link",async()=>{
   let snapshot=readLatest(ctx); const entries:OutboxEntry[]=[],events=typeof given==="function"?given():given;
   for (const pending of readOutboxSince(ctx, snapshot.seq)) {
    if (pending.seq !== snapshot.seq + 1) throw Error("outbox sequence gap; latest snapshot requires recovery");
    snapshot = reduce(snapshot, pending.envelope, pending.at ?? ctx.now);
   }
   for(const event of events){snapshot=reduce(snapshot,event,ctx.now);entries.push({seq:snapshot.seq,at:ctx.now,envelope:event});}
   if(entries.length){appendOutbox(ctx,entries,false,false);writeJsonAtomic(latestPath(ctx),snapshot);rotateOutbox(ctx);notifyOutbox(ctx);}
   report.seq=snapshot.seq;
  },{timeoutMs:5000});
  report.transports.push("outbox");
 } catch(e){report.errors.push(`outbox: ${e instanceof Error?e.message:String(e)}`);}
 return report;
}
