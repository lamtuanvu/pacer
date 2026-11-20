import { CoreError } from "../core/errors";
import type { Ctx } from "../types";
import { callOp } from "./ops";

const CAPTURE_OPS = new Set([
  "desktop.capture.register",
  "desktop.capture.targets",
  "desktop.capture.request",
  "desktop.capture.claim",
  "desktop.capture.complete",
  "desktop.capture.result",
]);

/**
 * Runs a `desktop.capture.*` op for the Rust front door, which already
 * validated the params (Zod-order). The capture broker is an in-memory map
 * only this process owns, so the sealed bridge runs the real handler.
 */
export async function captureBridge(ctx: Ctx, body: unknown) {
  const request = body && typeof body === "object" && !Array.isArray(body)
    ? (body as { op?: unknown; params?: unknown })
    : {};
  if (typeof request.op !== "string" || !CAPTURE_OPS.has(request.op)) {
    throw new CoreError("invalid_input", "unknown desktop capture bridge op");
  }
  return await callOp(ctx, request.op, request.params ?? {}, {});
}
