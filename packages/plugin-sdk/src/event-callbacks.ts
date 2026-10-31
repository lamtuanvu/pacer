import type {PolicyEvent} from './policy';
export const EVENT_TYPES=['desktop.update','plugin','pause','task','mode','config','reset','planner','executor','account','host','repo','counts','attention','activity','job','notify'] as const;
export function isPolicyEvent(value:unknown):value is PolicyEvent {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const event=value as PolicyEvent;
  return Number.isSafeInteger(event.seq)&&event.seq>=0&&Number.isFinite(event.at)&&(EVENT_TYPES as readonly string[]).includes(event.type)&&Object.hasOwn(event,'data');
}
const bytes=(event:PolicyEvent)=>Buffer.byteLength(JSON.stringify(event));
/** A slow callback cannot retain an unbounded host notification backlog. */
export class EventCallbacks {
  private queue:PolicyEvent[]=[];
  private current:PolicyEvent|undefined;
  private running=false;
  private closed=false;
  private settle!:()=>void;
  private stopped=new Promise<void>(resolve=>{this.settle=resolve;});
  constructor(private readonly callback:(event:PolicyEvent)=>void|Promise<void>,private readonly fatal:()=>void) {}
  get pending():{count:number;bytes:number} {return {count:this.queue.length+(this.current?1:0),bytes:this.queue.reduce((sum,e)=>sum+bytes(e),0)+(this.current?bytes(this.current):0)};}
  close():void {this.closed=true;this.queue=[];this.current=undefined;this.settle();}
  push(event:PolicyEvent):void {
    if(this.closed)return;
    const pending=this.queue.length+(this.current?1:0);
    const total=this.queue.reduce((sum,e)=>sum+bytes(e),0)+(this.current?bytes(this.current):0);
    if(bytes(event)>256*1024-1024||pending+1>127||total+bytes(event)>256*1024-1024) {
      if(this.current&&this.queue.some(e=>e.type==='reset')){this.close();this.fatal();return;}
      this.queue=[{seq:event.seq,at:event.at,type:'reset',data:{reason:'event callback requires resnapshot',cursor:event.seq}}];
    } else this.queue.push(event);
    void this.drain();
  }
  private async drain():Promise<void> {
    if(this.running)return;this.running=true;
    try {while(!this.closed&&this.queue.length){this.current=this.queue.shift()!;const event=this.current;try {await Promise.race([Promise.resolve().then(()=>this.callback(event)),this.stopped]);}catch{try{console.error('plugin event callback failed');}catch{}}this.current=undefined;}}
    finally {this.running=false;}
  }
}
