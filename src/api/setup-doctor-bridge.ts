import { CoreError, toCoreError } from "../core/errors";
import { doctorParts, integrationHashes } from "../core/setup";
import { currentVersion } from "../update/version";
import type { Ctx } from "../types";
import { toApiError } from "./errors";
import { parseOpParams } from "./ops";
import { setupCheckParts } from "./setup-check-bridge";

const SETUP_DOCTOR_OPS = new Set(["setup.health", "doctor.run"]);

/**
 * The Core-only parts of `doctor.run` and `setup.health` for the Rust front door, which stamps and stores the doctor
 * report and owns the gate. A gate input that fails after the diagnostics ran comes back as `failure`, because the
 * doctor report of that run is still stored before the gate reports the error.
 */
export async function setupDoctorBridge(ctx: Ctx, body: unknown) {
  const request = body && typeof body === "object" && !Array.isArray(body)
    ? (body as { op?: unknown; params?: unknown; snapshotProbe?: unknown })
    : {};
  if (typeof request.op !== "string" || !SETUP_DOCTOR_OPS.has(request.op)) {
    throw new CoreError("invalid_input", "unknown setup doctor bridge op");
  }
  parseOpParams(ctx, request.op, request.params ?? {});
  const doctor = await doctorParts(ctx);
  if (request.op === "doctor.run") return { doctor };
  try {
    const snapshotProbe = typeof request.snapshotProbe === "boolean" ? request.snapshotProbe : undefined;
    const facts = await setupCheckParts(ctx, snapshotProbe);
    return { doctor, facts, version: currentVersion(), integrationHashes: integrationHashes(ctx) };
  } catch (e) {
    return { doctor, failure: toApiError(toCoreError(e)) };
  }
}
