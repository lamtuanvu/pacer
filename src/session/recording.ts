import { appendFileSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { decodeLog, encodeHeader, encodeRecord, type Frame } from "./framing";
import { PlainText } from "./plain";
import { Screen, type Checkpoint } from "./screen";
export class Recording extends Screen {
  private transcript = new PlainText();
  private size = 0;
  private enabled = true;
  private startedAt = Date.now()/1000;
  private cap: number;
  constructor(readonly dir:string, options: {capBytes?:number} = {}) {
    super(); this.cap=options.capBytes ?? 8*1024*1024; this.newLog(); this.checkpoint();
  }
  disable() { this.enabled=false; }
  /** A full disk must disable recording, never terminate the agent. */
  private disk(fn:()=>void) { if (this.enabled) try { fn(); } catch { this.enabled=false; } }
  private newLog() {
    const h=encodeHeader({cols:this.term.cols,rows:this.term.rows,startedAt:this.startedAt,generation:this.generation,outputOffset:this.outputOffset});
    this.disk(()=>writeFileSync(join(this.dir,"session.log"),h,{mode:0o600})); this.size=h.length;
  }
  checkpoint() {
    this.disk(()=> { const p=join(this.dir,"session.ckpt"); writeFileSync(`${p}.tmp`,JSON.stringify(this.snapshot()),{mode:0o600}); renameSync(`${p}.tmp`,p); });
  }
  private record(type:number,data:Uint8Array) {
    const frame=encodeRecord(type,(Date.now()/1000-this.startedAt)*1000,data);
    this.disk(()=>appendFileSync(join(this.dir,"session.log"),frame)); this.size+=frame.length;
    if(this.size >= this.cap && this.transcript.atBoundary) {
      this.checkpoint();
      this.disk(()=>renameSync(join(this.dir,"session.log"),join(this.dir,"session.log.1")));
      this.generation++; this.newLog();
    }
  }
  override async output(data:Uint8Array) {
    if (!data.length) return;
    await super.output(data);
    const plain=this.transcript.push(data);
    this.record(1,data);
    if(plain) this.disk(()=>appendFileSync(join(this.dir,"stdout"),plain,{mode:0o600}));
  }
  /** Resume only when the complete requested suffix still exists in retained generations. */
  since(from:number): Buffer[] | null {
    if(!Number.isSafeInteger(from) || from<0 || from>this.outputOffset) return null;
    if(from===this.outputOffset) return [];
    let next=from;const chunks:Buffer[]=[];
    try {
      for(const name of ["session.log.1","session.log"]) {
        const path=join(this.dir,name);if(!existsSync(path)) continue;
        const log=decodeLog(readFileSync(path));let offset=log.header.outputOffset ?? 0;
        for(const frame of log.frames) if(frame.type===1) {
          const end=offset+frame.data.length;
          if(end>next) {
            if(offset>next) return null;
            chunks.push(frame.data.subarray(next-offset));next=end;
          }
          offset=end;
        }
      }
    } catch {return null;}
    return next===this.outputOffset?chunks:null;
  }
  override resize(cols:number,rows:number) {
    super.resize(cols,rows);
    const bytes=Buffer.alloc(4);bytes.writeUInt16BE(cols,0);bytes.writeUInt16BE(rows,2);
    this.record(2,bytes);
  }
  marker(event:string,label:string) { this.record(3,Buffer.from(JSON.stringify({event,label}))); }
  async close() { const tail=this.transcript.flush(); if(tail) this.disk(()=>appendFileSync(join(this.dir,"stdout"),tail,{mode:0o600})); this.dispose(); }
}
export function readRecording(dir:string): {checkpoint?:Checkpoint; frames:Frame[]} {
  const checkpoint = existsSync(join(dir,"session.ckpt")) ? JSON.parse(readFileSync(join(dir,"session.ckpt"),"utf8")) as Checkpoint : undefined;
  const frames:Frame[]=[];
  // The checkpoint covers a prefix of the absolute masked output stream.
  let offset=0;
  let current;
  try { current=decodeLog(readFileSync(join(dir,"session.log"))); }
  catch(error) {
    // A crash between rename and new-header creation leaves the previous generation.
    if(existsSync(join(dir,"session.log.1"))) current=decodeLog(readFileSync(join(dir,"session.log.1")));
    else if(checkpoint) return {checkpoint,frames};
    else throw error;
  }
  offset=current.header.outputOffset ?? (checkpoint && current.header.generation > checkpoint.generation ? checkpoint.outputOffset : 0);
  for(const frame of current.frames) {
    if(frame.type===1) {
      const end=offset+frame.data.length;
      if(end > (checkpoint?.outputOffset ?? 0)) frames.push({...frame,data:frame.data.subarray(Math.max(0,(checkpoint?.outputOffset ?? 0)-offset))});
      offset=end;
    } else if(offset >= (checkpoint?.outputOffset ?? 0)) frames.push(frame);
  }
  return {checkpoint,frames};
}
export async function replayRecording(dir:string):Promise<Screen> {
  const {checkpoint,frames}=readRecording(dir), screen=new Screen();
  if(checkpoint) await screen.restore(checkpoint);
  for(const frame of frames) {
    if(frame.type===1) await screen.output(frame.data);
    if(frame.type===2 && frame.data.length===4) screen.resize(frame.data.readUInt16BE(0),frame.data.readUInt16BE(2));
  }
  return screen;
}
