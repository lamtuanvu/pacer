import { toV2Snapshot, V2_PROTOCOL, callV2Op, v2Hello } from "./v2-compat";
import { sessionCookie } from "../serve/app-routes";
import * as core from "../core";
import type { Status } from "../engine/status";
import type { Ctx } from "../types";
import { eventsSince, liveSnapshot, liveV2Snapshot } from "./events";
import { isExecutorSession } from "../install/role";
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
export async function handleV2(req: Request, deps: { getCtx: () => Ctx; opDeps?: OpDeps; tailMs?: number; status?: () => Promise<Status>; snapshot?: () => ReturnType<typeof liveSnapshot> }): Promise<Response> {
  const url = new URL(req.url);
  const version=url.pathname.startsWith("/v3/")?3:2;
  const pathname=version===3?url.pathname.replace(/^\/v3\//,"/v2/"):url.pathname;
  const tailMs = deps.tailMs ?? 1_000;
  try {
    if (deps.getCtx().env.PACER_WORK_GRANT && (version !== 3 || req.method !== "POST" || !pathname.startsWith("/v2/ops/")))
      return errorResponse({ code: "not_allowed", message: "Work grants only allow scoped protocol 3 operations" }, 403);
    if (pathname === "/v2/session/exchange") {
      if (req.method !== "POST") return errorResponse({ code: "invalid_input", message: "method not allowed" }, 405);
      return new Response(null, { status: 204, headers: { "Set-Cookie": sessionCookie(deps.getCtx()), "Cache-Control": "no-store" } });
    }
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
      // A window or process id the client picks once, so two instances of one client contend for a lane's driving lease.
      const instance=req.headers.get("X-Pacer-Client-Instance")??"";
      const clientInstance=/^[A-Za-z0-9._:-]{1,64}$/.test(instance)?{label:client??(label==="app"?"app":"http"),id:instance}:undefined;
      const result = pathname === "/v2/ops/routing.status" && !deps.getCtx().env.PACER_WORK_GRANT && deps.status && (params === null || (typeof params === "object" && !Array.isArray(params)))
        ? await deps.status()
        : await (version===3?callOp:callV2Op)(deps.getCtx(), pathname.slice("/v2/ops/".length), params, {...deps.opDeps,client,clientInstance});
      return Response.json({ result });
    }
    if (req.method !== "GET") return errorResponse({ code: "invalid_input", message: "method not allowed" }, 405);
    if (pathname === "/v2/hello") return Response.json(version===3?helloBody():v2Hello());
    if (pathname === "/v2/snapshot") {
      if (!deps.snapshot) return Response.json(await (version === 3 ? liveSnapshot : liveV2Snapshot)(deps.getCtx(), { status: deps.status }));
      const result = await deps.snapshot();
      if (version === 3) return Response.json(result);
      const snapshot = toV2Snapshot(result.snapshot);
      return Response.json({ protocol: V2_PROTOCOL, seq: snapshot.seq, snapshot });
    }
    if (pathname === "/v2/events") {
      let last = Number(req.headers.get("last-event-id") ?? url.searchParams.get("since") ?? 0);
      if (!Number.isSafeInteger(last) || last < 0) return errorResponse({ code: "invalid_input", message: "since must be a non-negative integer" });
      return sse(tailMs, send => {
        const batch = eventsSince(deps.getCtx(), last,version);
        for (const e of batch.events) send(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`);
        last = batch.last;
        return false;
      });
    }
    const streamRoute = pathname.match(/^\/v2\/assistant\/turns\/([A-Za-z0-9_-]{1,128})\/stream$/);
    if (streamRoute) {
      if (version !== 3) return errorResponse({ code: "unknown_op", message: "The assistant needs protocol 3" }, 404);
      if (isExecutorSession(deps.getCtx())) return errorResponse({ code: "not_allowed", message: "PACER_ROLE=executor: executors cannot use the assistant." });
      return (await import("../assistant/stream")).assistantStream(streamRoute[1]!);
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

/** Both versioned route families share auth, body limits and streaming behavior. */
export const handleV3 = handleV2;
