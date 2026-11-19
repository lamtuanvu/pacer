import { CoreError } from "../core/errors";
import type { Ctx } from "../types";
import { callOp } from "./ops";

const UPDATE_OPS = new Set([
  "desktop.update.status",
  "desktop.update.check",
  "desktop.update.download",
  "desktop.update.restart",
  "desktop.update.cancel",
  "desktop.update.adopt",
  "desktop.update.adoptCancel",
  "desktop.update.configure",
]);

/**
 * Runs a `desktop.update.*` op for the Rust front door, which already
 * validated the strict params (Zod-order). The desktop update runtime is an
 * in-memory service registration only this process owns, so the sealed
 * bridge runs the real handler; effectful install/restart stay in Core.
 */
export async function updateBridge(ctx: Ctx, body: unknown) {
  const request = body && typeof body === "object" && !Array.isArray(body)
    ? (body as { op?: unknown; params?: unknown })
    : {};
  if (typeof request.op !== "string" || !UPDATE_OPS.has(request.op)) {
    throw new CoreError("invalid_input", "unknown desktop update bridge op");
  }
  return await callOp(ctx, request.op, request.params ?? {}, {});
}