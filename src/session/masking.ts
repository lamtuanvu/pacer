/** Exact bytes only: retain enough trailing bytes to match across chunks. */
export class SecretMasker {
  private tail = Buffer.alloc(0);
  private secrets: Buffer[];
  private maxLen: number;
  constructor(values: string[]) {
    this.secrets = [...new Set(values)].filter(v => Array.from(v).length >= 8).map(v => Buffer.from(v)).sort((a,b) => b.length-a.length);
    this.maxLen = this.secrets[0]?.length ?? 0;
  }
  private consume(final: boolean): Buffer {
    const out: Buffer[] = [];
    const end = final ? this.tail.length : Math.max(0, this.tail.length - this.maxLen + 1);
    let pos = 0;
    while (pos < end) {
      let at = -1, match: Buffer | undefined;
      for (const secret of this.secrets) {
        const index = this.tail.indexOf(secret, pos);
        // Secrets are longest first, so ties preserve the longest match.
        if (index >= 0 && (at < 0 || index < at)) { at = index; match = secret; }
      }
      if (at < 0 || at >= end) { out.push(this.tail.subarray(pos, end)); pos = end; break; }
      if (at > pos) out.push(this.tail.subarray(pos, at));
      out.push(Buffer.from("****")); pos = at + match!.length;
    }
    this.tail = Buffer.from(this.tail.subarray(pos));
    return Buffer.concat(out);
  }
  push(data: Uint8Array): Buffer {
    if (!this.secrets.length) return Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    this.tail = Buffer.concat([this.tail,data]);
    return this.consume(false);
  }
  flush(): Buffer { return this.consume(true); }
}
