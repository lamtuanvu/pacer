import type { Readable } from "node:stream";
import { CoreError } from "../core/errors";

/** One bounded read from the owned SSH stdout; the caller owns the I/O deadline. */
export function readDuplexChunk(stream: Readable, length: number, signal: AbortSignal,
  pollMs?: number, closed: () => boolean = () => false): Promise<{ base64: string; eof: boolean }> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { if (poll) clearTimeout(poll); stream.off("readable", take); stream.off("end", ended); stream.off("close", ended); stream.off("error", failed); signal.removeEventListener("abort", cancelled); };
    const done = (result: { base64: string; eof: boolean }) => { cleanup(); resolve(result); };
    const failed = () => { cleanup(); reject(new CoreError("plugin_unavailable", "SSH duplex output failed")); };
    const cancelled = () => { cleanup(); reject(signal.reason); };
    const takeAvailable = () => {
      const available = Math.min(length, stream.readableLength);
      // A zero-length read lets a drained stream that already saw EOF emit end.
      if (available <= 0) { stream.read(0); return false; }
      const bytes = stream.read(available) as Buffer | null;
      if (!bytes) return false;
      done({ base64: bytes.toString("base64"), eof: false });
      return true;
    };
    // Node can emit close before a queued readable callback for a short-lived child.
    const ended = () => { if (!takeAvailable()) done({ base64: "", eof: true }); };
    const poll = pollMs ? setTimeout(() => done({ base64: "", eof: false }), pollMs) : undefined;
    poll?.unref();
    const take = () => {
      if (takeAvailable()) return;
      if (stream.readableEnded || closed()) ended();
    };
    stream.on("readable", take); stream.once("end", ended); stream.once("close", ended); stream.once("error", failed);
    signal.addEventListener("abort", cancelled, { once: true });
    if (signal.aborted) cancelled(); else take();
  });
}
