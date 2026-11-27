import { CoreError, toCoreError } from "../core/errors";
import { doctorParts } from "../core/setup";
import type { Ctx } from "../types";
import { parseOpParams } from "./ops";

const SETUP_DOCTOR_OPS = new Set(["setup.health", "doctor.run"]);

/**
 * The Core-only doctor checks for `doctor.run` and `setup.health`. The Rust
 * front door gathers setup facts itself (service, link, agents, login and
 * integration hashes) and owns the gate; this bridge only runs the diagnostics
 * that need Core's in-process plugin registry and hook handlers.
 */
export async function setupDoctorBridge(ctx: Ctx, body: unknown) {
  const request = body && typeof body === "object" && !Array.isArray(body)
    ? (body as { op?: unknown; params?: unknown })
    : {};
  if (typeof request.op !== "string" || !SETUP_DOCTOR_OPS.has(request.op)) {
    throw new CoreError("invalid_input", "unknown setup doctor bridge op");
  }
  parseOpParams(ctx, request.op, request.params ?? {});
  return { doctor: await doctorParts(ctx) };
}
