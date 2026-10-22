import { join } from "node:path";
import { z } from "zod";
import { readinessProofSchema } from "../../../src/update/desktop/native-record";
import { sameProcess } from "../../../src/update/desktop/process-identity";
import { verifyExerciseSurvivors } from "../ota-outcome";
import { ControlError } from "./contract";
import type { OtaRecord } from "../ota";
import type { FixtureJobs } from "../ota-native";
import type { readNativeTransaction } from "../../../src/update/desktop/native-record";
import type { NativeProcess } from "../../../src/update/desktop/native-os";
import type { ProcessIdentity } from "./lease";

export interface OtaControlEvidence {
  state: OtaRecord;
  transaction: ReturnType<typeof readNativeTransaction>;
  jobs: FixtureJobs;
  processes: NativeProcess[];
  identity: ProcessIdentity | null;
  captures: unknown;
  clients: unknown;
  appSha256: string;
}
const windowSchema = z.object({
  pid: z.number().int().positive(), window_id: z.string().regex(/^[0-9]{1,20}$/),
  label: z.enum(["main", "tray"]), client_id: z.string().min(1).max(256),
}).strict();
export type ControlWindow = z.infer<typeof windowSchema>;
export interface DesktopControlBinding {
  source: "ordinary" | "ota";
  identity: ProcessIdentity;
  appSha256: string;
  version?: string;
  transactionId?: string;
  installationId?: string;
  windows?: ControlWindow[];
}
function refuse(): never { throw new ControlError("target_unavailable", "completed OTA desktop authority is unavailable or changed"); }
/** Projection only. Callers must acquire these observations through the fixed resolver. */
export function proveOtaControlBinding(evidence: OtaControlEvidence): DesktopControlBinding {
  const { state, transaction: tx, jobs, processes, identity, appSha256 } = evidence;
  const exercise = state.exercise, runtime = state.runtime, target = tx.command.target;
  if (state.phase !== "prepared" || !state.nativeFixture || exercise?.scenario !== "upgrade" ||
      exercise.state !== "complete" || !exercise.transactionId || exercise.faults.length ||
      runtime?.state !== "managed" || runtime.request !== null || !tx.authorization ||
      tx.record.phase !== "complete" || tx.journal.state !== "committed" ||
      tx.command.installationId !== exercise.installationId || target.id !== exercise.installationId ||
      tx.record.installationId !== exercise.installationId || tx.command.transactionId !== exercise.transactionId ||
      tx.record.transactionId !== exercise.transactionId || tx.journal.manifestSha256 !== tx.digest ||
      target.ownership !== "managed" || target.appPath !== state.currentApp || target.pacerHome !== state.pacerHome ||
      tx.command.candidate.version !== state.nativeFixture.candidateVersion || !/^[a-f0-9]{64}$/.test(appSha256)) refuse();
  const proof = readinessProofSchema.parse(tx.journal.verificationProof);
  const version = state.nativeFixture.candidateVersion;
  if (proof.installationId !== exercise.installationId || proof.transactionId !== exercise.transactionId ||
      proof.desktopVersion !== version || proof.serviceVersion !== version) refuse();
  if (jobs.jobs.length !== 2 || jobs.jobs[0].label !== state.serviceLabel || jobs.jobs[1].label !== state.recoveryLabel ||
      jobs.desktops.length !== 1 || !sameProcess(jobs.desktops[0], proof.desktop)) refuse();
  verifyExerciseSurvivors(tx.journal, jobs, state.serviceLabel, state.recoveryLabel);
  const service = jobs.jobs[0], registration = state.registrations[0];
  if (service.state !== "loaded" || service.executable !== join(state.currentApp, "Contents/Resources/pacer") ||
      registration.label !== service.label || registration.state !== "loaded" || !registration.sha256 ||
      registration.sha256 !== service.registrationSha256 || !registration.processes.some(p => sameProcess(p, proof.service))) refuse();
  for (const [expected, executable] of [
    [proof.desktop, join(state.currentApp, "Contents/MacOS/pacer")],
    [proof.service, join(state.currentApp, "Contents/Resources/pacer")],
  ] as const) {
    const matches = processes.filter(p => sameProcess(p.process, expected));
    if (matches.length !== 1 || matches[0].executable !== executable) refuse();
  }
  // This projection is Darwin-only: both public ABI readers independently observed
  // the same PID and start timeval; never translate an unobserved birth identity.
  if (!identity || identity.pid !== proof.desktop.pid || identity.start_identity !== proof.desktop.birth) refuse();
  const windows = z.array(windowSchema).min(1).max(2).parse(evidence.captures);
  const clients = z.array(z.object({ client_id: z.string(), kind: z.string(), version: z.string() }).passthrough()).max(256).parse(evidence.clients);
  if (windows.some(w => w.pid !== proof.desktop.pid || w.client_id !== windows[0].client_id) ||
      new Set(windows.map(w => w.window_id)).size !== windows.length || new Set(windows.map(w => w.label)).size !== windows.length) refuse();
  const worker = clients.filter(c => c.client_id === windows[0].client_id);
  if (worker.length !== 1 || worker[0].kind !== "desktop" || worker[0].version !== version) refuse();
  return { source: "ota", identity: { ...identity }, appSha256, version,
    transactionId: exercise.transactionId, installationId: exercise.installationId, windows: windows.map(w => ({ ...w })) };
}
/** Window lists may change; process, image, transaction and worker authority may not. */
export function assertSameControlBinding(before: DesktopControlBinding, after: DesktopControlBinding): void {
  const key = (b: DesktopControlBinding) => JSON.stringify([b.source, b.identity, b.appSha256, b.version, b.installationId, b.transactionId, b.windows?.[0]?.client_id]);
  if (key(before) !== key(after)) throw new ControlError("stale_reference", "desktop control authority changed; resolve a fresh command", "not_delivered");
}
