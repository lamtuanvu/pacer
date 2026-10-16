import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Recording } from "../session/recording";
import { SecretMasker } from "../session/masking";
import { sessionSecrets } from "../session/host";
import type { Ctx } from "../types";

/** util-linux wraps the output log with one header and one trailer line. */
class ScriptOutput {
  private header = true;
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

/** No unbounded local raw copy: the same phase-1 writer owns caps and rotation. */
export class RemoteRecording {
  readonly recording: Recording;
  offset = 0;
  private raw = new ScriptOutput();
  private mask: SecretMasker;
  private closed = false;
  constructor(ctx: Ctx, readonly dir: string) {
    let capBytes: number | undefined;
    try { capBytes = JSON.parse(readFileSync(join(dir,"session.json"),"utf8")).capBytes; } catch { /* default cap */ }
    chmodSync(dir, 0o700);
    // A new observer reconstructs the bounded recording from the authoritative remote log.
    writeFileSync(join(dir,"stdout"),"",{mode:0o600});
    rmSync(join(dir,"session.log.1"),{force:true});
    this.recording = new Recording(dir, {capBytes});
    this.mask = new SecretMasker(sessionSecrets(ctx.env, ctx.pacerHome));
  }
  async output(bytes: Uint8Array): Promise<Buffer> {
    if (this.closed) return Buffer.alloc(0);
    const output = this.mask.push(this.raw.push(bytes));
    await this.recording.output(output);
    this.offset += bytes.length;
    return output;
  }
  async close() {
    if (this.closed) return Buffer.alloc(0);
    const tail = Buffer.concat([this.mask.push(this.raw.flush()), this.mask.flush()]);
    await this.recording.output(tail);
    this.recording.checkpoint();
    await this.recording.close();
    this.closed = true;
    return tail;
  }
}
