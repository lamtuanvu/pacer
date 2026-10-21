import { z } from "zod";
import { captureBroker } from "../desktop/capture-broker";
import { list as listClients } from "../clients/registry";
import { CoreError } from "../core/errors";
import type { OpDef } from "./ops";
const id = z.string().min(1).max(128);
const credential = z.string().regex(/^[0-9a-f]{64}$/);
const op = <P extends z.ZodTypeAny>(definition: OpDef<P>) => definition as unknown as OpDef;
export const desktopOps: Record<string, OpDef> = {
  "desktop.capture.register": op({
    description: "Renew a capture worker credential for an existing connected desktop instance after expiry or recovery.",
    params: z.object({ client_id: id }),
    handler: (ctx, params) => {
      if (!listClients(ctx).some(client => client.client_id === params.client_id && client.kind === "desktop")) throw new CoreError("not_found", "Desktop instance is not connected");
      return { worker_token: captureBroker(ctx.pacerHome).register(params.client_id) };
    },
  }),
  "desktop.capture.targets": op({ description: "List owned windows reported by connected authenticated desktop capture workers.", params: z.object({}), handler: ctx => captureBroker(ctx.pacerHome).targets() }),
  "desktop.capture.request": op({
    description: "Request a capture of an owned desktop main or tray window; poll desktop.capture.result.",
    params: z.object({ client_id: id, window: z.enum(["main", "tray"]), mode: z.enum(["window", "content"]).default("window"), window_id: z.string().regex(/^[0-9]{1,20}$/).optional() }),
    handler: (ctx, params) => {
      if (!listClients(ctx).some(client => client.client_id === params.client_id && client.kind === "desktop")) throw new CoreError("not_found", "Desktop instance is not connected");
      return captureBroker(ctx.pacerHome).request(params.client_id, params.window, params.mode, params.window_id);
    },
  }),
  "desktop.capture.claim": op({
    description: "Claim the next capture for the authenticated desktop worker; worker credential comes from client.register capture=true.",
    params: z.object({ client_id: id, worker_token: credential, windows: z.array(z.object({label: z.enum(["main", "tray"]), window_id: z.string().regex(/^[0-9]+$/), pid: z.number().int().min(2)})).max(2).optional() }),
    handler: (ctx, params) => captureBroker(ctx.pacerHome).claim(params.client_id, params.worker_token, params.windows),
  }),
  "desktop.capture.complete": op({
    description: "Report a failed capture. Successful PNG bytes use the bounded authenticated image upload route.",
    params: z.object({ request_id: id, worker_token: credential, error: z.enum(["permission_denied", "window_unavailable", "unsupported_platform", "capture_failed", "capture_timeout"]) }),
    handler: (ctx, params) => captureBroker(ctx.pacerHome).fail(params.request_id, params.worker_token, params.error),
  }),
  "desktop.capture.result": op({
    description: "Read capture status/metadata; completed PNG is at /v3/desktop/capture/<request_id>/image with normal authentication.",
    params: z.object({ request_id: id }), handler: (ctx, params) => captureBroker(ctx.pacerHome).result(params.request_id),
  }),
};
