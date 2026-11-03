import { z } from "zod";
import { CoreError } from "../core/errors";
import { assessReconciliation } from "../update/desktop/reconciliation-assessment";
import type { OpDef } from "./ops";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const request = z.object({ candidateId: identifier, expectRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), requestId: identifier }).strict();
const unavailable = () => { throw new CoreError("unavailable", "Service reconciliation is unavailable"); };

const op = <P extends z.ZodTypeAny>(definition: OpDef<P>) => definition as unknown as OpDef;
export const desktopReconciliationOps: Record<string, OpDef> = {
  "desktop.reconcile.status": op({ description: "Read bounded service reconciliation assessment; claims do not constitute native proof.", params: z.object({}).strict(), handler: () => assessReconciliation(undefined) }),
  "desktop.reconcile.request": op({ description: "Request reconciliation of an inspected candidate; unavailable until native proof and implementation exist.", params: request, handler: unavailable }),
  "desktop.reconcile.cancel": op({ description: "Cancel reconciliation; unavailable until reconciliation is implemented.", params: request, handler: unavailable }),
};
