import { z } from 'zod';
import { clientAction, clientControl } from '../clients/control';
import type { OpDef } from './ops';
const id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/), token = z.string().regex(/^[0-9a-f]{64}$/);
const worker = {client_id: id, worker_token: token};
const op = <P extends z.ZodTypeAny>(definition: OpDef<P>) => definition as unknown as OpDef;
export const clientControlOps: Record<string, OpDef> = {
  'client.control.enroll': op({description: 'Enroll a connected app-page control worker; ephemeral credential is used only by that page. Does not grant native update authority.', params: z.object({kind:z.enum(['app','desktop']),window:z.enum(['main','tray'])}), handler:(ctx,p)=>clientControl(ctx.pacerHome).enroll(p.kind,p.window)}),
  'client.control.targets': op({description:'List connected page targets for appearance, navigation and native window controls. Select an explicit client_id.',params:z.object({}),handler:ctx=>clientControl(ctx.pacerHome).targets()}),
  'client.control.request': op({description:'Request an allowlisted action on an explicit connected client; navigation requires a main target to preserve its form guard. Poll client.control.result; pending is not success. Native quit may disconnect before acknowledgment, leaving an unknown outcome.',params:z.object({client_id:id,action:clientAction}),handler:(ctx,p)=>clientControl(ctx.pacerHome).request(p.client_id,p.action)}),
  'client.control.result': op({description:'Read client action status and acknowledgment; timeout is failed, never successful.',params:z.object({request_id:id}),handler:(ctx,p)=>clientControl(ctx.pacerHome).result(p.request_id)}),
  'client.control.claim': op({description:'Page worker polls for an action; renews its 60-second lease. Worker credential must remain private.',params:z.object(worker),handler:(ctx,p)=>clientControl(ctx.pacerHome).claim(p.client_id,p.worker_token)}),
  'client.control.complete': op({description:'Page worker acknowledges an applied action or a bounded failure code.',params:z.object({request_id:id,worker_token:token,result:z.json().optional(),error:z.enum(['unsupported','client_failed','navigation_cancelled']).optional()}),handler:(ctx,p)=>clientControl(ctx.pacerHome).complete(p.request_id,p.worker_token,p.result,p.error)}),
};
