import { open } from "node:fs/promises";
import { openStateFile } from "./storage";

/** Incremental object reader: at most one JSON entry is materialized at a time. */
class Reader {
  private buffer = "";
  private position = 0;
  private eof = false;
  private readonly decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  constructor(private file: Awaited<ReturnType<typeof open>>, private check: () => void) {}
  async peek(): Promise<string> {
    while (this.position >= this.buffer.length && !this.eof) {
      this.check();
      const bytes = new Uint8Array(262144);
      const { bytesRead } = await this.file.read(bytes);
      this.buffer = this.decoder.decode(bytes.subarray(0, bytesRead), { stream: bytesRead !== 0 });
      this.position = 0;
      if (!bytesRead) this.eof = true;
    }
    return this.buffer[this.position] ?? "";
  }
  async take(): Promise<string> { const c = await this.peek(); this.position++; return c; }
  async whitespace() {
    while (true) {
      await this.peek();
      while (this.position < this.buffer.length) {
        const code = this.buffer.charCodeAt(this.position);
        if (code !== 32 && code !== 9 && code !== 13 && code !== 10) return;
        this.position++;
      }
      if (this.eof) return;
    }
  }
  async expect(c: string) { await this.whitespace(); if (await this.take() !== c) throw new Error("invalid state JSON"); }
  async value(): Promise<unknown> {
    await this.whitespace();
    const chunks: string[] = [];
    let depth = 0, quoted = false, escaped = false, complete = false;
    while (await this.peek()) {
      this.check();
      const start = this.position;
      // Scan one decoded input chunk synchronously. Awaiting once per character
      // makes a large compatible cursor entry spend its deadline on promises.
      while (this.position < this.buffer.length) {
        const c = this.buffer[this.position]!;
        if (!quoted && depth === 0 && (c === "," || c === "}" || c === "]")) {
          complete = true; break;
        }
        this.position++;
        if (quoted) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') quoted = false; }
        else if (c === '"') quoted = true;
        else if (c === "{" || c === "[") depth++;
        else if (c === "}" || c === "]") depth--;
        if (!quoted && depth === 0 && (c === '"' || c === "}" || c === "]")) { complete = true; break; }
      }
      chunks.push(this.buffer.slice(start, this.position));
      if (complete) break;
    }
    return JSON.parse(chunks.join(""));
  }
  async object(action: (key: string, reader: Reader) => Promise<void>) {
    await this.expect("{"); await this.whitespace();
    if (await this.peek() === "}") { await this.take(); return; }
    while (true) {
      const key = await this.value(); if (typeof key !== "string") throw new Error("invalid state key");
      await this.expect(":"); await action(key, this); await this.whitespace();
      const c = await this.take(); if (c === "}") return; if (c !== ",") throw new Error("invalid state object");
    }
  }
  async end() { await this.whitespace(); if (await this.peek() !== "") throw new Error("trailing state data"); }
}
export async function readCursorFile(path: string, check: () => void): Promise<{ version: unknown; files: Record<string, unknown> }> {
  const file = await openStateFile(path);
  try {
    const reader = new Reader(file, check);
    let version: unknown; let files: Record<string, unknown> = Object.create(null);
    await reader.object(async (key, r) => {
      if (key === "files") {
        // JSON.parse uses the final duplicate property, even if earlier values
        // have a different shape. Validate only the selected final map.
        files = Object.create(null);
        await r.whitespace();
        if (await r.peek() === "{") await r.object(async (path, entry) => { files[path] = await entry.value(); });
        else await r.value();
      }
      else if (key === "version") version = await r.value();
      else await r.value();
    });
    await reader.end(); return { version, files };
  } finally { await file.close(); }
}
