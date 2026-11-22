// GET /v3/runs/<runId>/artifacts/<artId> — serve a stored step artifact after app auth.
import { httpStatus, toApiError } from "../api/protocol";
import { CoreError } from "../core/errors";
import type { Ctx } from "../types";
import { getArtifact } from "../workflow/artifacts";
import { getRun } from "../workflow/store";

/** Called only after the service has checked Host and bearer/cookie/Origin auth. */
export async function artifactRoute(req: Request, ctx: Ctx): Promise<Response | null> {
  const url = new URL(req.url);
  const match = url.pathname.match(/^\/v3\/runs\/(run_[a-z2-7]{10})\/artifacts\/(art_[a-z2-7]{10})$/);
  if (!match) return null;
  try {
    if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
    const runId = match[1]!;
    const artId = match[2]!;
    if (!getRun(ctx, runId)) throw new CoreError("not_found", `unknown run ${runId}`);
    const file = getArtifact(ctx, runId, artId);
    if (!file) throw new CoreError("not_found", `unknown artifact ${artId}`);
    const dangerous = /^(text\/html|image\/svg\+xml)\b/i.test(file.mime);
    // M9: PDFs as attachment (html/svg already attachment); other types stay inline.
    const attachment = dangerous || /^application\/pdf\b/i.test(file.mime);
    return new Response(Bun.file(file.absPath), {
      headers: {
        "Content-Type": file.mime,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": dangerous
          ? "default-src 'none'; sandbox; form-action 'none'; base-uri 'none'"
          : "default-src 'none'",
        "Cache-Control": "no-store",
        "Content-Disposition": attachment
          ? `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`
          : `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      },
    });
  } catch (error) {
    const value = toApiError(error);
    return Response.json({ error: value }, { status: httpStatus(value.code) });
  }
}
