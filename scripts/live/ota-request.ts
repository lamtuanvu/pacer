/** Scripts-only single-request capability; never read by the production service. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { ApiError } from "../../src/api/client-types";
import { sameProcess, type ProcessIdentity } from "../../src/update/desktop/process-identity";
import { FIXTURE_UPDATE_OPS, type OtaExercise, type OtaRuntime } from "./ota-exercise-record";
import { emitOtaRequestTrace, type OtaTraceSink, type OtaTraceStage } from "./ota-request-trace";
const base = z.object({ installationId: z.string().regex(/^[a-f0-9]{64}$/), requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/), expectRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict();
/** A confirmed CAS rejection did not mutate state. Lost/uncertain responses never retry. */
export async function retryFixtureRevision(attempt: () => Promise<void>, rejected: () => void, restartSession?: () => Promise<void>, awaitAdoptionOffer?: () => Promise<void>): Promise<void> {
  for (let count = 0; ; count++) {
    try { await attempt(); return; } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      const revision = error.code === "conflict" && error.message === "Desktop update conflict: revision changed";
      // restart's native session check precedes request persistence. This
      // opt-in never applies to downloads, uncertain replies, or other refusals.
      const reconnect = restartSession && error.code === "not_allowed" && error.message === "Verified desktop update connection is unavailable";
      // An automatic check can start between the offer and the adopt request;
      // the service refuses before persisting and asks for a fresh request.
      const adoption = awaitAdoptionOffer && error.code === "conflict" && error.message === "Desktop service adoption changed";
      if (!revision && !reconnect && !adoption) throw error;
      rejected();
      if (count === 4) throw error;
      if (reconnect) await restartSession!();
      if (adoption) await awaitAdoptionOffer!();
    }
  }
}
export function fixtureRequest(op: string, params: unknown): NonNullable<OtaRuntime["request"]> {
  const operation = z.enum(FIXTURE_UPDATE_OPS).parse(op);
  const value = (operation === "desktop.update.restart" ? base.extend({ version: z.literal("0.2.4") }).strict() : operation === "desktop.update.configure" ? base.extend({ autoDownload: z.boolean() }).strict() : base).parse(params);
  const canonical = Object.keys(value).sort().map(key => [key, (value as Record<string, unknown>)[key]]);
  return { op: operation, requestId: value.requestId, paramsSha256: createHash("sha256").update(JSON.stringify(canonical)).digest("hex") };
}
export function permitsFixtureRequest(state: { exercise: OtaExercise | null; runtime: OtaRuntime | null }, method: string, path: string, params: unknown, observedDriver: ProcessIdentity | null): boolean {
  try {
    const { runtime, exercise } = state;
    if (method !== "POST" || !path.startsWith("/v3/ops/") || !runtime || runtime.state !== "managed" || !exercise || exercise.state !== "running" || !sameProcess(runtime.driver, exercise.driver) || !sameProcess(runtime.driver, observedDriver)) return false;
    const requested = fixtureRequest(path.slice("/v3/ops/".length), params);
    return (params as { installationId: string }).installationId === exercise.installationId && runtime.request !== null && Object.entries(requested).every(([key, value]) => runtime.request![key as keyof typeof requested] === value);
  } catch { return false; }
}

/** Proxy gate: a recorded request is necessary, and native ownership is re-proven. */
export async function authorizeFixtureRequest(session: import("./core").Session, request: Request, trace?: OtaTraceSink): Promise<boolean> {
  let stage: OtaTraceStage = "initial-policy";
  const emit = (outcome: "start" | "pass" | "refused" | "error") => emitOtaRequestTrace(trace, { stage, outcome });
  try {
    const url = new URL(request.url);
    if (request.method !== "POST" || !FIXTURE_UPDATE_OPS.some(op => url.pathname === `/v3/ops/${op}`) || url.search) {
      emit("refused");
      return false;
    }
    stage = "body";
    emit("start");
    const reader = request.clone().body?.getReader();
    if (!reader) { emit("refused"); return false; }
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 4096) { emit("refused"); return false; }
        chunks.push(part.value);
      }
    } finally { await reader.cancel(); }
    const params = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    emit("pass");
    stage = "initial-policy";
    emit("start");
    const { dirname } = await import("node:path"), { readOtaRecord } = await import("./ota"), { processIdentity } = await import("../../src/update/desktop/process-identity");
    const options = { base: dirname(session.root) }, state = readOtaRecord(session.id, options);
    if (state.phase !== "prepared" || !state.nativeFixture || !permitsFixtureRequest(state, request.method, url.pathname, params, state.runtime ? processIdentity(state.runtime.driver.pid) : null)) {
      emit("refused");
      return false;
    }
    emit("pass");
    stage = "native-ownership";
    emit("start");
    const { inspectFixtureJobs, fixtureInstallation } = await import("./ota-native");
    const installation = fixtureInstallation(state, await inspectFixtureJobs(state), state.nativeFixture.baselineVersion);
    if (installation.id !== state.exercise?.installationId) { emit("refused"); return false; }
    emit("pass");
    stage = "final-policy";
    emit("start");
    const latest = readOtaRecord(session.id, options);
    const permitted = permitsFixtureRequest(latest, request.method, url.pathname, params, latest.runtime ? processIdentity(latest.runtime.driver.pid) : null);
    emit(permitted ? "pass" : "refused");
    return permitted;
  } catch {
    emit("error");
    return false;
  }
}
