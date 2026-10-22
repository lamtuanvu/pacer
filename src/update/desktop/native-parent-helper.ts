/** Fixed helper capability held only by an authenticated paired Core generation. */
import { closeSync, createReadStream, createWriteStream, readSync, writeSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { requestParentHelper } from "./native-socket";

export interface ParentHelperRequest { schema: 1; path: string; sha256: string; version: string }
export interface ParentHelperProcess {
  pid: number;
  stdin: WritableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  /** A generation-bound request, never a signal to an unowned PID. */
  abort(): void;
}
export class ParentHelperSpawner {
  private closed = false;
  constructor(private readonly channel: number) {}
  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.channel);
  }
  spawn(request: ParentHelperRequest): ParentHelperProcess {
    if (this.closed) throw Error("Native parent helper channel is retired");
    let result: ReturnType<typeof requestParentHelper>;
    try { result = requestParentHelper(this.channel, request); }
    catch (error) { this.close(); throw error; }
    const remaining = new Set([result.stdin, result.stdout, result.control]);
    const streams: { destroy(): unknown }[] = [];
    try {
      const input = createWriteStream("", { fd: result.stdin, autoClose: true });
      streams.push(input);
      remaining.delete(result.stdin);
      const output = createReadStream("", { fd: result.stdout, autoClose: true });
      streams.push(output);
      remaining.delete(result.stdout);
      const stdin = Writable.toWeb(input) as WritableStream<Uint8Array>;
      const stdout = Readable.toWeb(output) as unknown as ReadableStream<Uint8Array>;
      remaining.delete(result.control);
      let aborted = false, controlClosed = false;
      // Bun's Node socket wrapper does not reliably start reading an inherited
      // socket FD. Use the same bounded nonblocking polling as native peers.
      const exited = (async () => {
        const bytes = Buffer.alloc(5);
        let length = 0;
        try {
          for (;;) {
            let count: number;
            try { count = readSync(result.control, bytes, length, bytes.length - length, null); }
            catch (error) {
              if (!["EAGAIN", "EWOULDBLOCK", "EINTR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
              await Bun.sleep(10);
              continue;
            }
            if (count === 0) {
              if (length !== 4) throw Error("Native helper exit status unavailable");
              return bytes.readInt32BE();
            }
            length += count;
            if (length > 4) throw Error("Native helper exit status unavailable");
          }
        } finally { controlClosed = true; closeSync(result.control); }
      })();
      // Callers can reject a freshly spawned image before installing an adapter.
      // Keep that rejection from becoming an unhandled exit-status promise.
      void exited.catch(() => {});
      return {
        pid: result.pid,
        stdin, stdout,
        exited,
        abort() {
          if (aborted || controlClosed) return;
          aborted = true;
          try { writeSync(result.control, Buffer.from("A")); } catch { /* Retired capability grants no PID signal fallback. */ }
        },
      };
    } catch (error) {
      for (const stream of streams) stream.destroy();
      for (const fd of remaining) closeSync(fd);
      this.close();
      throw error;
    }
  }
}
