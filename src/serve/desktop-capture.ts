import { captureMetadataSchema } from "../desktop/capture-contract";
import { CAPTURE_MAX_BYTES, captureBroker } from "../desktop/capture-broker";
import { httpStatus, toApiError } from "../api/protocol";
import { CoreError } from "../core/errors";
import type { Ctx } from "../types";
/** Called only after normal service Host/authentication/Origin guards. */
export async function desktopCaptureRoute(req: Request, ctx: Ctx, options: { uploadTimeoutMs?: number } = {}): Promise<Response | null> {
  const match = new URL(req.url).pathname.match(/^\/v3\/desktop\/capture\/([0-9a-f-]{36})\/image$/);
  if (!match) return null;
  const broker = captureBroker(ctx.pacerHome);
  let upload: { nonce: string; deadline_ms: number } | undefined;
  try {
    if (req.method === "GET") return new Response(Buffer.from(broker.image(match[1])), {
      headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
    });
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const worker = req.headers.get("X-Pacer-Capture-Worker") ?? "";
    const scale = Number(req.headers.get("X-Pacer-Capture-Scale"));
    const method = req.headers.get("X-Pacer-Capture-Method");
    if (method !== "window" && method !== "content") throw new CoreError("invalid_input", "Unknown capture method");
    // Reserve before reading: duplicate readers cannot each allocate another 16 MiB.
    upload = broker.beginUpload(match[1], worker);
    if (Number(req.headers.get("Content-Length")) > CAPTURE_MAX_BYTES) throw new CoreError("too_large", "Capture exceeds 16 MiB");
    const reader = req.body?.getReader();
    if (!reader) throw new CoreError("invalid_input", "Capture image body is required");
    const chunks: Uint8Array[] = [];
    let size = 0;
    let rejectDeadline: (reason: Error) => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
    let interrupted = false;
    const cancel = () => {
      interrupted = true;
      void reader.cancel().catch(() => {});
      rejectDeadline(new CoreError("conflict", "Capture upload was cancelled or expired"));
    };
    const delay = Math.max(1, Math.min(upload.deadline_ms - Date.now(), options.uploadTimeoutMs ?? 10000));
    const timer = setTimeout(cancel, delay);
    req.signal.addEventListener("abort", cancel, { once: true });
    try {
      if (req.signal.aborted) cancel();
      for (;;) {
        const part = await Promise.race([reader.read(), cancelled]);
        if (part.done) break;
        size += part.value.byteLength;
        if (size > CAPTURE_MAX_BYTES) throw new CoreError("too_large", "Capture exceeds 16 MiB");
        chunks.push(part.value);
      }
      if (interrupted || req.signal.aborted || Date.now() >= upload.deadline_ms) throw new CoreError("conflict", "Capture upload expired");
      const bytes = Buffer.concat(chunks);
      let raw: unknown;
      try { raw = JSON.parse(req.headers.get("X-Pacer-Capture-Metadata") ?? "null"); } catch { throw new CoreError("invalid_input", "Invalid capture metadata header"); }
      const parsed = captureMetadataSchema.safeParse(raw);
      if (!parsed.success || parsed.data.method !== method || parsed.data.scale !== scale) throw new CoreError("invalid_input", "Capture metadata header is incomplete or inconsistent");
      return Response.json({ result: broker.complete(match[1], worker, bytes, parsed.data, upload.nonce) });
    } finally {
      clearTimeout(timer);
      req.signal.removeEventListener("abort", cancel);
      chunks.length = 0;
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } catch (error) {
    const body = toApiError(error);
    return Response.json({ error: body }, { status: httpStatus(body.code) });
  } finally {
    if (upload) broker.releaseUpload(match[1], upload.nonce);
  }
}
