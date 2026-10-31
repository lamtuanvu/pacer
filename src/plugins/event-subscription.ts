import type {eventsSince} from '../api/events';
import {CoreError} from '../core/errors';
import {ReadOwner} from './read-owner';
import {POLICY_EVENT_TYPES,policyEvent,type PolicyEvent} from './policy-protocol';

export const EVENT_QUEUE_COUNT=128,EVENT_QUEUE_BYTES=256*1024;
const size=(event:PolicyEvent)=>Buffer.byteLength(JSON.stringify({jsonrpc:'2.0',method:'$/event',params:event})+'\n');
interface Options {
  deliver(event:PolicyEvent,guard:()=>void):Promise<void>;
  onRetire?(reason:string):void;
  read(cursor:number):ReturnType<typeof eventsSince>;
}
/** One future-only canonical API cursor and bounded transport queue per process owner. */
export class EventSubscription {
  private readonly read:(cursor:number)=>ReturnType<typeof eventsSince>;
  private queue:{event:PolicyEvent;bytes:number}[]=[];
  private inFlight:{event:PolicyEvent;bytes:number}|undefined;
  private pumping:Promise<void>|undefined;
  private flushing=false;
  private retired=false;
  private position:number;
  private readonly types:ReadonlySet<string>;
  constructor(readonly owner:ReadOwner,types:readonly string[],private readonly options:Options) {
    owner.assertGranted('events.subscribe');
    if(owner.ctx.env.PACER_WORK_GRANT)throw new CoreError('not_allowed','Work grants cannot subscribe to global events');
    if(!types.length||types.length>32||new Set(types).size!==types.length||types.some(type=>!(POLICY_EVENT_TYPES as readonly string[]).includes(type)))throw new CoreError('invalid_input','invalid unique event types');
    this.types=new Set(types);
    this.read=options.read;
    this.position=this.read(0).last;
  }
  get cursor():number{return this.position;}
  get active():boolean{return !this.retired;}
  get pending():{count:number;bytes:number} {
    return {count:this.queue.length+(this.inFlight?1:0),bytes:this.queue.reduce((sum,item)=>sum+item.bytes,0)+(this.inFlight?.bytes??0)};
  }
  retire(reason?:string,revoke=true):void {
    if(this.retired)return;
    this.retired=true;if(revoke)this.owner.revoke();this.queue=[];this.inFlight=undefined;
    if(reason)this.options.onRetire?.(reason);
  }
  private guard=()=>{if(this.retired)throw new CoreError('capability_denied','subscription retired');this.owner.assertGranted('events.subscribe');};
  pump():Promise<void> {
    if(this.retired)return Promise.resolve();
    if(this.pumping)return this.pumping;
    this.pumping=Promise.resolve().then(()=>{
      this.guard();const batch=this.read(this.position);const selected:PolicyEvent[]=[];
      let reset=batch.reset&&!batch.events.some(event=>event.type==='reset');
      for(const raw of batch.events) {
        if(raw.type!=='reset'&&!this.types.has(raw.type))continue;
        const parsed=policyEvent.safeParse(raw);
        if(!parsed.success||size(parsed.data)>EVENT_QUEUE_BYTES-1024){reset=true;break;}
        selected.push(parsed.data);
      }
      const additions=selected.reduce((sum,event)=>sum+size(event),0),pending=this.pending;
      if(reset||pending.count+selected.length>EVENT_QUEUE_COUNT-1||pending.bytes+additions>EVENT_QUEUE_BYTES-1024) {
        const event:PolicyEvent={seq:batch.last,at:this.owner.readContext().now,type:'reset',data:{reason:'event delivery requires resnapshot',cursor:batch.last}};
        this.queue=[{event,bytes:size(event)}];
      } else this.queue.push(...selected.map(event=>({event,bytes:size(event)})));
      this.position=batch.last;void this.flush();
    }).catch(()=>{this.retire('event generation or projection unavailable');}).finally(()=>{this.pumping=undefined;});
    return this.pumping;
  }
  private async flush():Promise<void> {
    if(this.flushing)return;this.flushing=true;
    try {
      while(!this.retired&&this.queue.length) {
        this.guard();this.inFlight=this.queue.shift()!;
        await this.options.deliver(this.inFlight.event,this.guard);
        this.inFlight=undefined;
      }
    } catch {this.retire('event notification delivery failed');}
    finally {this.flushing=false;}
  }
}
