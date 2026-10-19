import { z } from "zod";
import { desktopUpdateRuntime } from "../update/desktop/service";
import type { OpDef, OpDeps } from "./ops";
import type { Ctx } from "../types";
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const request = { installationId: identifier, requestId: identifier, expectRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) };
const runtime = (ctx: Ctx, deps: OpDeps) => deps.desktopUpdates ?? desktopUpdateRuntime(ctx);
const op = <P extends z.ZodTypeAny>(definition: OpDef<P>) => definition as unknown as OpDef;
export const desktopUpdateOps: Record<string, OpDef> = {
  "desktop.update.status": op({ description: "Read a registered desktop installation's public update status.", params: z.object({ installationId: identifier }).strict(), handler: (ctx, p, deps) => runtime(ctx, deps).status(p.installationId) }),
  "desktop.update.check": op({ description: "Check the verified desktop release feed, bypassing the cached check; update-check opt-outs still apply.", params: z.object(request).strict(), handler: (ctx, p, deps) => runtime(ctx, deps).check(p) }),
  "desktop.update.download": op({ description: "Download and verify the offered complete desktop release.", params: z.object(request).strict(), handler: (ctx, p, deps) => runtime(ctx, deps).download(p) }),
  "desktop.update.restart": op({ description: "Request restart into the displayed desktop version/revision when idle; permission expires with the verified desktop session.", params: z.object({ ...request, version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/) }).strict(), handler: (ctx, p, deps) => {
    const service = runtime(ctx, deps);
    return service.restart({ ...p, clientId: service.boundClientId(p.installationId) });
  } }),
  "desktop.update.cancel": op({ description: "Cancel a desktop check, download or waiting restart before reservation.", params: z.object(request).strict(), handler: (ctx, p, deps) => runtime(ctx, deps).cancel(p) }),
  "desktop.update.configure": op({ description: "Set automatic desktop downloads without granting restart permission.", params: z.object({ ...request, autoDownload: z.boolean() }).strict(), handler: (ctx, p, deps) => runtime(ctx, deps).configure(p) }),
};
