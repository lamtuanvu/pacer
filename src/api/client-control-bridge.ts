import { clientControl } from "../clients/control";
import { list as listClients } from "../clients/registry";
import { CoreError } from "../core/errors";
import { captureBroker } from "../desktop/capture-broker";
import type { Ctx } from "../types";
import { callOp } from "./ops";

const CONTROL_OPS = new Set([
  "client.control.enroll", "client.control.targets", "client.control.request",
  "client.control.result", "client.control.claim", "client.control.complete",
]);

/** Whether the front door's serde documents repeat this value as `JSON.stringify` writes it. */
function bridgeSafe(value: unknown): boolean {
  if (typeof value === "string") return value.isWellFormed();
  if (typeof value === "number") return Number.isSafeInteger(value) || (Math.abs(value) >= 1e-3 && Math.abs(value) < 1e15);
  if (Array.isArray(value)) return value.every(bridgeSafe);
  if (value && typeof value === "object") return Object.entries(value).every(([key, item]) => key.isWellFormed() && bridgeSafe(item));
  return true;
}

/** The stored request this operation would answer with, read before it changes anything. */
function answered(ctx: Ctx, op: string, params: Record<string, unknown>): unknown[] {
  const broker = clientControl(ctx.pacerHome);
  if (op === "client.control.claim") return [broker.nextPending(String(params.client_id))];
  if (op === "client.control.result") return [broker.stored(String(params.request_id))];
  if (op === "client.control.complete") return [broker.stored(String(params.request_id)), params.result];
  return [];
}

/**
 * Params of the sealed client control route: the HTTP `/_internal/client-control` body and the stdio
 * `_internal.client-control` params beside `key`. `{forward: true}` asks the door to run the original
 * request here, because the reply holds a value its serde documents cannot carry exactly.
 */
export async function clientControlBridge(ctx: Ctx, request: unknown): Promise<{ reply: unknown } | { forward: true }> {
  const { op, params, client_id } = (request && typeof request === "object" ? request : {}) as { op?: unknown; params?: unknown; client_id?: unknown };
  if (op === "client.capture.register" && typeof client_id === "string") {
    if (!listClients(ctx).some(client => client.client_id === client_id && client.kind === "desktop")) throw new CoreError("not_found", "Desktop instance is not connected");
    return { reply: captureBroker(ctx.pacerHome).register(client_id) };
  }
  if (typeof op !== "string" || !CONTROL_OPS.has(op) || !params || typeof params !== "object") throw new CoreError("invalid_input", "invalid client control bridge request");
  if (!answered(ctx, op, params as Record<string, unknown>).every(bridgeSafe)) return { forward: true };
  return { reply: await callOp(ctx, op, params) };
}
