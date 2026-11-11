import { CoreError } from "../core/errors";
import type { Ctx } from "../types";
import { callOp } from "./ops";

const SETUP_DOCTOR_OPS = new Set(["setup.health", "doctor.run"]);

/** Runs `setup.health` or `doctor.run` for the Rust front door, which validated the params. */
export async function setupDoctorBridge(ctx: Ctx, body: unknown) {
  const request = body && typeof body === "object" && !Array.isArray(body)
    ? (body as { op?: unknown; params?: unknown; snapshotProbe?: unknown })
    : {};
  if (typeof request.op !== "string" || !SETUP_DOCTOR_OPS.has(request.op)) {
    throw new CoreError("invalid_input", "unknown setup doctor bridge op");
  }
  const snapshotProbe = typeof request.snapshotProbe === "boolean" ? request.snapshotProbe : undefined;
  return await callOp(ctx, request.op, request.params ?? {}, { snapshotProbe });
}
