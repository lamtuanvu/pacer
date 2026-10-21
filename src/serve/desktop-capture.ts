import { CAPTURE_MAX_BYTES, captureBroker } from "../desktop/capture-broker";
import { httpStatus, toApiError } from "../api/protocol";
import { CoreError } from "../core/errors";
import type { Ctx } from "../types";
/** Called only after the service's normal Host/authentication/Origin guards. */
export async function desktopCaptureRoute(req: Request, ctx: Ctx): Promise<Response | null> {
  const match = new URL(req.url).pathname.match(/^\/v3\/desktop\/capture\/([0-9a-f-]{36})\/image$/);
  if (!match) return null;
  const broker = captureBroker(ctx.pacerHome);
  try {
    if (req.method === "GET") return new Response(Buffer.from(broker.image(match[1])), { headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } });
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
    // Authorize before consuming the stream; never permit arbitrary output paths.
    const worker = req.headers.get("X-Pacer-Capture-Worker") ?? "";
    const scale = Number(req.headers.get("X-Pacer-Capture-Scale"));
    const method = req.headers.get("X-Pacer-Capture-Method");
    if (method !== "window" && method !== "content") throw new CoreError("invalid_input", "Unknown capture method");
    broker.validateUpload(match[1], worker);
    if (Number(req.headers.get("Content-Length")) > CAPTURE_MAX_BYTES) throw new CoreError("too_large", "Capture exceeds 16 MiB");
    const chunks: Uint8Array[] = []; let size = 0;
    const reader = req.body?.getReader();
    if (reader) try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > CAPTURE_MAX_BYTES) { await reader.cancel(); throw new CoreError("too_large", "Capture exceeds 16 MiB"); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    const bytes = Buffer.concat(chunks);
    return Response.json({ result: broker.complete(match[1], worker, bytes, { method, scale }) });
  } catch (error) { const body = toApiError(error); return Response.json({ error: body }, { status: httpStatus(body.code) }); }
}
