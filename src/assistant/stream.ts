import { subscribeTurn, type StreamFrame } from "./service";

const MAX_FRAMES_PER_SECOND = 10;

/**
 * Ephemeral per-turn stream: SSE `data:` frames of `{delta}`, `{status}` or `{done}`. In memory only, so answer text is not
 * written to the event outbox. Deltas are coalesced to at most ten frames a second; the stream closes when the turn ends.
 */
export function assistantStream(turnId: string): Response {
  const enc = new TextEncoder();
  let off: (() => void) | null = null, timer: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let pending = "", closed = false;
      const write = (frame: unknown) => { if (!closed) controller.enqueue(enc.encode(`data: ${JSON.stringify(frame)}\n\n`)); };
      const flush = () => { if (pending) { write({ delta: pending }); pending = ""; } };
      const close = () => { if (closed) return; flush(); closed = true; clearInterval(timer); off?.(); try { controller.close(); } catch { /* client went away */ } };
      const onFrame = (frame: StreamFrame) => {
        if ("delta" in frame) { pending += frame.delta; return; }
        flush(); write(frame);
        if ("done" in frame) close();
      };
      write({ status: "connected" });
      off = subscribeTurn(turnId, onFrame);
      if (!off) { write({ done: { state: "error", error: "That answer is no longer streaming. Open the conversation to read it." } }); close(); return; }
      timer = setInterval(flush, 1000 / MAX_FRAMES_PER_SECOND);
    },
    cancel() { clearInterval(timer); off?.(); },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}
