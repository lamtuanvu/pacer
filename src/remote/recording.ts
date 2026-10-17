import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Recording } from "../session/recording";
import { PlainText } from "../session/plain";
import { encodeHeader } from "../session/framing";
import { Screen, type Checkpoint } from "../session/screen";
import { sessionSecrets } from "../session/host";
import type { Ctx } from "../types";

/** util-linux wraps the output log with one header and one trailer line. */
class ScriptOutput {
  header = true;
  get pendingBytes() { return this.pending.length; }
  private pending = Buffer.alloc(0);
  private trailer = Buffer.from("\nScript done on ");
  push(bytes: Uint8Array): Buffer {
    this.pending = Buffer.concat([this.pending, bytes]);
    if (this.header) {
      const end = this.pending.indexOf(10);
      if (end < 0) return Buffer.alloc(0);
      this.header = false;
      if (this.pending.subarray(0, end).toString().startsWith("Script started on ")) this.pending = this.pending.subarray(end + 1);
    }
    const at = this.pending.lastIndexOf(this.trailer);
    if (at >= 0) {
      const candidate = this.pending.subarray(at);
      const end = candidate.indexOf(10, 1);
      if ((end < 0 && candidate.length < 4096) ||
          (end === candidate.length - 1 && /^\nScript done on [^\n]* \[COMMAND_EXIT_CODE="[0-9]+"\]\n$/.test(candidate.toString()))) {
        const output = this.pending.subarray(0, at);
        this.pending = candidate;
        return output;
      }
    }
    let keep = Math.min(this.pending.length, this.trailer.length - 1);
    while (keep && !this.pending.subarray(-keep).equals(this.trailer.subarray(0, keep))) keep--;
    // PTY newlines are CRLF; their LF belongs to output, not script's LF-only trailer.
    if (keep === 1 && this.pending.at(-2) === 13) keep = 0;
    const output = this.pending.subarray(0, this.pending.length - keep);
    this.pending = this.pending.subarray(this.pending.length - keep);
    return output;
  }
  flush(): Buffer {
    const bytes = this.pending;
    this.pending = Buffer.alloc(0);
    return /^\nScript done on [^\n]* \[COMMAND_EXIT_CODE="[0-9]+"\]\n$/.test(bytes.toString()) ? Buffer.alloc(0) : bytes;
  }
}

/** Retain raw secret candidates in memory; persist only the cursor before them. */
class ResumableMasker {
  pending = Buffer.alloc(0);
  private secrets: Buffer[];
  private max: number;
  constructor(values: string[]) {
    this.secrets = [...new Set(values)].filter(s=>Array.from(s).length>=8).map(s=>Buffer.from(s)).sort((a,b)=>b.length-a.length);
    this.max = this.secrets[0]?.length ?? 0;
  }
  push(bytes: Uint8Array, final = false): Buffer {
    if (!this.secrets.length) return Buffer.from(bytes);
    this.pending = Buffer.concat([this.pending,bytes]);
    const end = final ? this.pending.length : Math.max(0,this.pending.length-this.max+1);
    const output: Buffer[] = []; let pos = 0;
    while (pos < end) {
      let at = -1, match: Buffer | undefined;
      for (const secret of this.secrets) {
        const found = this.pending.indexOf(secret,pos);
        if (found>=0 && (at<0 || found<at)) {at=found;match=secret;}
      }
      if (at<0 || at>=end) {output.push(this.pending.subarray(pos,end));pos=end;break;}
      output.push(this.pending.subarray(pos,at),Buffer.from("****"));pos=at+match!.length;
    }
    this.pending = Buffer.from(this.pending.subarray(pos));
    return Buffer.concat(output);
  }
  flush() { return this.push(Buffer.alloc(0),true); }
}
interface MirrorState {
  offset: number;
  header: boolean;
  snapshot: Checkpoint;
  line: string;
  closed: boolean;
  terminal: string;
}

/** No unbounded local raw copy: the same phase-1 writer owns caps and rotation. */
export class RemoteRecording {
  readonly recording: Recording;
  readonly ready: Promise<void>;
  offset = 0;
  private raw = new ScriptOutput();
  private mask: ResumableMasker;
  private closed = false;
  private transcript = new PlainText();
  private line = Buffer.alloc(0);
  private terminal = Buffer.alloc(0);
  constructor(ctx: Ctx, readonly dir: string) {
    let capBytes: number | undefined;
    try { capBytes = JSON.parse(readFileSync(join(dir,"session.json"),"utf8")).capBytes; } catch { /* default cap */ }
    chmodSync(dir, 0o700);
    let saved: MirrorState | undefined;
    try { saved = JSON.parse(readFileSync(join(dir,"session.remote.json"),"utf8")); } catch { /* first observation */ }
    this.mask = new ResumableMasker(sessionSecrets(ctx.env, ctx.pacerHome));
    if (!saved) writeFileSync(join(dir,"stdout"),"",{mode:0o600});
    const recording = this.recording = new Recording(dir, {capBytes});
    this.ready = (async()=>{
      if (!saved) return;
      this.offset = saved.offset;
      this.raw.header = saved.header;
      this.closed = saved.closed;
      this.line = Buffer.from(saved.line,"base64");
      this.terminal = Buffer.from(saved.terminal ?? "","base64");
      // Seed the unfinished masked transcript before restoring the terminal checkpoint.
      this.transcript.push(this.line);
      await recording.output(this.line);
      recording.term.reset();
      recording.resize(saved.snapshot.cols,saved.snapshot.rows);
      // Screen.restore dispatches through Recording.output, which would append a duplicate transcript.
      await Screen.prototype.output.call(recording,Buffer.from(saved.snapshot.scrollbackAnsi+saved.snapshot.screenAnsi));
      recording.generation=saved.snapshot.generation;
      recording.outputOffset=saved.snapshot.outputOffset;
      writeFileSync(join(dir,"session.log"),encodeHeader({cols:saved.snapshot.cols,rows:saved.snapshot.rows,startedAt:Date.now()/1000,generation:saved.snapshot.generation,outputOffset:saved.snapshot.outputOffset}),{mode:0o600});
      recording.checkpoint();
      if (saved.closed) await recording.close();
    })();
  }
  private complete(bytes: Buffer, final = false): Buffer {
    const input=Buffer.concat([this.terminal,bytes]);
    let boundary=0;
    const probe=new PlainText();
    for(let i=0;i<input.length;i+=4096) {
      const end=Math.min(input.length,i+4096);
      probe.push(input.subarray(i,end));
      if(probe.atBoundary) boundary=end;
    }
    if(boundary<input.length && !final) {
      const tail=new PlainText();
      for(let i=boundary;i<input.length;i++) {
        tail.push(input.subarray(i,i+1));
        if(tail.atBoundary) boundary=i+1;
      }
    }
    if(final) boundary=input.length;
    this.terminal=Buffer.from(input.subarray(boundary));
    return input.subarray(0,boundary);
  }
  private track(bytes: Buffer) {
    let start = 0, lastReset = -1;
    for (let at = bytes.indexOf(10); at>=0; at=bytes.indexOf(10,at+1)) {
      if (this.transcript.push(bytes.subarray(start,at+1))) {this.line=Buffer.alloc(0);lastReset=at+1;}
      start=at+1;
    }
    this.transcript.push(bytes.subarray(start));
    this.line = Buffer.concat([this.line,lastReset>=0 ? bytes.subarray(lastReset) : bytes]);
  }
  private persist() {
    this.recording.checkpoint();
    const state: MirrorState = {
      // These withheld bytes have produced no local output and must be reread after restart.
      offset:this.offset-this.raw.pendingBytes-this.mask.pending.length,
      header:this.raw.header, snapshot:this.recording.snapshot(),line:this.line.toString("base64"),closed:this.closed,terminal:this.terminal.toString("base64"),
    };
    const path=join(this.dir,"session.remote.json");
    writeFileSync(`${path}.tmp`,JSON.stringify(state),{mode:0o600});renameSync(`${path}.tmp`,path);
  }
  async output(bytes: Uint8Array): Promise<Buffer> {
    await this.ready;
    if (this.closed) return Buffer.alloc(0);
    const output = this.complete(this.mask.push(this.raw.push(bytes)));
    await this.recording.output(output);
    this.track(output);
    this.offset += bytes.length;
    this.persist();
    return output;
  }
  async close() {
    await this.ready;
    if (this.closed) return Buffer.alloc(0);
    const tail = this.complete(Buffer.concat([this.mask.push(this.raw.flush()), this.mask.flush()]),true);
    await this.recording.output(tail);
    this.track(tail);
    await this.recording.close();
    this.closed = true;
    this.line = Buffer.alloc(0);
    this.persist();
    return tail;
  }
}
