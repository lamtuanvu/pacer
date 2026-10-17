import * as core from "../core";
import type { Status } from "../engine/status";
import type { Ctx } from "../types";
import { eventsSince, liveSnapshot } from "./events";
import { callOp, type OpDeps } from "./ops";
import { helloBody, httpStatus, toApiError, type ApiErrorBody } from "./protocol";

const errorResponse = (error: ApiErrorBody["error"], status = httpStatus(error.code)) =>
  Response.json({ error }, { status });

/** Poll immediately, then until cancelled or the source reports completion. */
function sse(tailMs: number, poll: (send: (frame: string) => void) => boolean): Response {
  const enc = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  let keepalive: ReturnType<typeof setInterval> | undefined;
  const clear = () => { clearInterval(timer); clearInterval(keepalive); };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (frame: string) => controller.enqueue(enc.encode(frame));
      const tick = () => {
        try {
          if (poll(send)) { clear(); controller.close(); return true; }
        } catch (e) { clear(); controller.error(e); return true; }
        return false;
      };
      send(": connected\n\n");
      if (tick()) return;
      timer = setInterval(tick, tailMs);
      keepalive = setInterval(() => {
        try { send(": keepalive\n\n"); } catch { clear(); }
      }, 15_000);
    },
    cancel: clear,
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

/** Auth is enforced by startServer before dispatching any v2 route. */
export async function handleV2(req: Request, deps: { getCtx: () => Ctx; opDeps?: OpDeps; tailMs?: number; status?: () => Promise<Status> }): Promise<Response> {
  const url = new URL(req.url), { pathname } = url;
  const tailMs = deps.tailMs ?? 1_000;
  try {
    if (pathname.startsWith("/v2/ops/")) {
      if (req.method !== "POST") return errorResponse({ code: "invalid_input", message: "method not allowed" }, 405);
      const max = 256 * 1024;
      const tooLarge = () => errorResponse({ code: "too_large", message: "body exceeds 256 KiB" });
      if (Number(req.headers.get("content-length")) > max) return tooLarge();
      const reader = req.body?.getReader(), decoder = new TextDecoder();
      let text = "", bytes = 0;
      if (reader) for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > max) { await reader.cancel(); return tooLarge(); }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
      let params: unknown;
      try { params = JSON.parse(text); }
      catch { return errorResponse({ code: "invalid_input", message: "body is not JSON" }); }
      const label=req.headers.get("X-Pacer-Client")??"";
      const client=/^[a-z][a-z0-9:-]{0,31}\/[0-9A-Za-z.+-]{1,32}$/.test(label)?label:undefined;
      const result = await callOp(deps.getCtx(), pathname.slice("/v2/ops/".length), params, {...deps.opDeps,client});
      return Response.json({ result });
    }
    if (req.method !== "GET") return errorResponse({ code: "invalid_input", message: "method not allowed" }, 405);
    if (pathname === "/v2/hello") return Response.json(helloBody());
    if (pathname === "/v2/snapshot") return Response.json(await liveSnapshot(deps.getCtx(), { status: deps.status }));
    if (pathname === "/v2/events") {
      let last = Number(req.headers.get("last-event-id") ?? url.searchParams.get("since") ?? 0);
      if (!Number.isSafeInteger(last) || last < 0) return errorResponse({ code: "invalid_input", message: "since must be a non-negative integer" });
      return sse(tailMs, send => {
        const batch = eventsSince(deps.getCtx(), last);
        for (const e of batch.events) send(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`);
        last = batch.last;
        return false;
      });
    }
    const logRoute = pathname.match(/^\/v2\/tasks\/([^/]+)\/log$/);
    if (logRoute && url.searchParams.get("follow") === "1") {
      const id = logRoute[1]!;
      // Resolve errors before sending SSE headers, so unknown tasks retain their HTTP code.
      let initial: ReturnType<typeof core.tasks.log> | undefined = core.tasks.log(deps.getCtx(), id);
      let offsets = { stdout: 0, stderr: 0 };
      return sse(tailMs, send => {
        for (let n = 0; n < 4; n++) {
          const chunk = initial ?? core.tasks.log(deps.getCtx(), id, offsets);
          initial = undefined;
          offsets = chunk.next;
          if (chunk.stdout || chunk.stderr) send(`event: log\ndata: ${JSON.stringify({ stdout: chunk.stdout, stderr: chunk.stderr })}\n\n`);
          if (!chunk.done) return false;
          // Drain completed logs across the core reader's bounded chunks before closing.
          if (!chunk.stdout && !chunk.stderr) { send("event: done\ndata: {}\n\n"); return true; }
        }
        return false;
      });
    }
    return errorResponse({ code: "unknown_op", message: "not found" });
  } catch (e) { return errorResponse(toApiError(e)); }
}
