import { deleteAttachment, draftAttachment, listAttachments, storeAttachment } from "../attachments/store";
import { httpStatus, toApiError } from "../api/protocol";
import { CoreError } from "../core/errors";
import type { Ctx } from "../types";

/** Called only after the service has checked Host and bearer/cookie/Origin auth. */
export async function attachmentRoute(req: Request, ctx: Ctx): Promise<Response | null> {
  const url = new URL(req.url);
  if (!/^\/v3\/attachments(?:\/[^/]+)?$/.test(url.pathname)) return null;
  try {
    const draftId = url.searchParams.get("draft") ?? "", id = url.pathname.split("/")[3];
    if (req.method === "POST" && !id) {
      if (!req.body) throw new CoreError("invalid_input", "Attachment bytes are required");
      const result = await storeAttachment(ctx, {draftId, batchId: url.searchParams.get("batch") ?? "",
        name: decodeURIComponent(req.headers.get("x-pacer-filename") ?? "attachment"), mime: req.headers.get("content-type") ?? "application/octet-stream", body: req.body});
      return Response.json(result, {status: 201});
    }
    if (req.method === "GET" && !id) return Response.json(listAttachments(ctx, draftId));
    if (req.method === "GET" && id) {
      const file = draftAttachment(ctx, draftId, id);
      return new Response(Bun.file(file.path), {headers: {"Content-Type": file.mime, "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'", "Cache-Control": "no-store", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`}});
    }
    if (req.method === "DELETE" && id) {deleteAttachment(ctx, draftId, id); return new Response(null, {status: 204});}
    return new Response("Method not allowed", {status: 405});
  } catch (error) {
    const value = toApiError(error instanceof URIError ? new CoreError("invalid_input", "Invalid filename encoding") : error);
    return Response.json({error: value}, {status: httpStatus(value.code)});
  }
}
