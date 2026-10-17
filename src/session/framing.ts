/** Session recording and socket v1. All multi-byte integers use network byte order. */
export interface LogHeader { cols: number; rows: number; startedAt: number; generation: number; outputOffset?: number }
export interface Frame { type: number; data: Buffer; ms?: number }
export const FrameType = { hello: 1, snapshot: 2, output: 3, resize: 4, control: 5, resync: 6, exit: 7, take: 8, release: 9, input: 10, size: 11 } as const;
export const MAX_FRAME = 16 * 1024 * 1024;
const MAGIC = Buffer.from("PACERTTY");
export function encodeHeader(header: LogHeader): Buffer {
  const json = Buffer.from(JSON.stringify(header)), b = Buffer.alloc(13);
  MAGIC.copy(b); b[8] = 1; b.writeUInt32BE(json.length, 9);
  return Buffer.concat([b, json]);
}
export function encodeRecord(type: number, ms: number, data: Uint8Array): Buffer {
  const b = Buffer.alloc(9); b[0] = type; b.writeUInt32BE(Math.min(0xffffffff, Math.max(0, Math.floor(ms))), 1); b.writeUInt32BE(data.length, 5);
  return Buffer.concat([b, data]);
}
export function decodeLog(b: Buffer): { header: LogHeader; frames: Frame[]; validBytes: number } {
  if (b.length < 13 || !b.subarray(0, 8).equals(MAGIC) || b[8] !== 1) throw Error("invalid session log header");
  const n = b.readUInt32BE(9);
  if (n > MAX_FRAME || b.length < 13 + n) throw Error("incomplete session log header");
  const header = JSON.parse(b.subarray(13, 13 + n).toString()) as LogHeader;
  let pos = 13 + n; const frames: Frame[] = [];
  while (pos + 9 <= b.length) {
    const len = b.readUInt32BE(pos + 5);
    if (len > MAX_FRAME) throw Error("session frame too large");
    if (pos + 9 + len > b.length) break;
    frames.push({ type:b[pos], ms:b.readUInt32BE(pos + 1), data:b.subarray(pos + 9, pos + 9 + len) }); pos += 9 + len;
  }
  return {header, frames, validBytes:pos};
}
export function wire(type: number, body: unknown): Buffer {
  const data = body instanceof Uint8Array ? Buffer.from(body) : Buffer.from(JSON.stringify(body));
  if (data.length > MAX_FRAME) throw Error("session frame too large");
  const h = Buffer.alloc(5); h[0] = type; h.writeUInt32BE(data.length, 1); return Buffer.concat([h, data]);
}
export class WireDecoder {
  private pending = Buffer.alloc(0);
  push(data: Uint8Array): Frame[] {
    this.pending = Buffer.concat([this.pending, data]); const frames: Frame[] = [];
    while (this.pending.length >= 5) {
      const n = this.pending.readUInt32BE(1);
      if (n > MAX_FRAME) throw Error("session frame too large");
      if (this.pending.length < 5 + n) break;
      frames.push({ type:this.pending[0], data:this.pending.subarray(5, 5 + n) }); this.pending = this.pending.subarray(5 + n);
    }
    return frames;
  }
}
