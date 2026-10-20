import { createHash } from "node:crypto";
import { readinessProofSchema } from "../../src/update/desktop/native-record";
import { sameProcess, type ProcessIdentity } from "../../src/update/desktop/process-identity";
import { MANAGED_SCENARIOS } from "./ota-exercise-record";
/** Cross-checks evidence; the public terminal phase alone never establishes success. */
export function verifyExerciseOutcome(scenario: string, installationId: string, transactionId: string, phase: string | undefined, manifestBytes: Buffer, journal: any): void {
  if (!(MANAGED_SCENARIOS as readonly string[]).includes(scenario)) throw Error("Unknown fixed scenario");
  const expected = scenario === "upgrade" ? "complete" : scenario === "restore-failure" ? "recovery-failed" : "restored";
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const offlineFailure = scenario === "restore-failure" && phase === undefined;
  if ((!offlineFailure && phase !== expected) || journal.state !== (expected === "complete" ? "committed" : expected) || manifest.binding?.transactionId !== transactionId || manifest.binding?.installationId !== installationId || journal.manifestSha256 !== createHash("sha256").update(manifestBytes).digest("hex")) throw Error("Native journal completion differs from public outcome");
  if (expected === "recovery-failed") return;
  const proof = readinessProofSchema.parse(expected === "complete" ? journal.verificationProof : journal.restorationProof);
  const version = expected === "complete" ? "0.2.4" : "0.2.3";
  if (proof.installationId !== installationId || proof.transactionId !== transactionId || proof.desktopVersion !== version || proof.serviceVersion !== version) throw Error("Readiness proof is for another installation, transaction or version");
}

/** Terminal proof must still describe live participants after the helper job exits. */
export function verifyExerciseSurvivors(journal: any, report: {desktops: ProcessIdentity[]; jobs: {label: string; loaded: boolean; process: ProcessIdentity | null}[]}, serviceLabel: string, recoveryLabel: string): void {
  if (!["committed", "restored"].includes(journal.state)) throw Error("Native outcome is not successful");
  const proof = readinessProofSchema.parse(journal.state === "committed" ? journal.verificationProof : journal.restorationProof);
  const service = report.jobs.find(job => job.label === serviceLabel), recovery = report.jobs.find(job => job.label === recoveryLabel);
  if (!service?.loaded || !sameProcess(service.process, proof.service) || !recovery || recovery.loaded || recovery.process ||
      !report.desktops.some(desktop => sameProcess(desktop, proof.desktop)) ||
      !["release-reservation", "retire-recovery"].every(kind => journal.steps?.some((step: any) => step.action.kind === kind && step.evidence?.kind === "complete"))) {
    throw Error("Native participants did not survive verified recovery retirement");
  }
}

const proofIdentity = (value: unknown): ProcessIdentity => {
  const p = value as ProcessIdentity | null;
  if (!p || !Number.isInteger(p.pid) || p.pid <= 0 || typeof p.bootId !== "string" || !p.bootId || typeof p.birth !== "string" || !p.birth) throw Error("Adoption proof lacks an exact process identity");
  return { pid: p.pid, bootId: p.bootId, birth: p.birth };
};
/** Adoption evidence: the journal, its manifest and the branch-specific readiness proof must agree. */
export function verifyAdoptionOutcome(scenario: string, installationId: string, transactionId: string, phase: string | undefined, manifestBytes: Buffer, journal: any): { branch: "managed" | "original"; resultingInstallationId: string; service: ProcessIdentity; desktop: ProcessIdentity } {
  if (scenario !== "adopt" && scenario !== "adopt-failure") throw Error("Unknown fixed adoption scenario");
  const expected = scenario === "adopt" ? "committed" : "restored", branch = scenario === "adopt" ? "managed" : "original";
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (phase !== expected || journal.state !== expected || journal.transactionKind !== "adoption" || manifest.transactionKind !== "adoption" ||
      manifest.binding?.transactionId !== transactionId || manifest.binding?.installationId !== installationId ||
      journal.manifestSha256 !== createHash("sha256").update(manifestBytes).digest("hex")) throw Error("Adoption journal differs from public outcome");
  const proof = expected === "committed" ? journal.verificationProof : journal.restorationProof;
  const resulting = branch === "managed" ? manifest.expectedNewInstallationId : installationId;
  if (!proof || proof.installationId !== installationId || proof.transactionId !== transactionId || proof.branch !== branch ||
      proof.resultingInstallationId !== resulting || proof.desktopSignedIn !== true || proof.validStateRead !== true ||
      proof.desktopVersion !== "0.2.3" || proof.serviceVersion !== "0.2.3") throw Error("Adoption readiness proof is for another branch, installation or version");
  return { branch, resultingInstallationId: resulting, service: proofIdentity(proof.service), desktop: proofIdentity(proof.desktop) };
}
/** After recovery retirement the proven service and Desktop must still be the live participants. */
export function verifyAdoptionSurvivors(journal: any, outcome: ReturnType<typeof verifyAdoptionOutcome>, report: {desktops: ProcessIdentity[]; jobs: {label: string; loaded: boolean; process: ProcessIdentity | null; executable: string | null}[]}, serviceLabel: string, recoveryLabel: string, executable: string): void {
  const service = report.jobs.find(job => job.label === serviceLabel), recovery = report.jobs.find(job => job.label === recoveryLabel);
  if (!service?.loaded || service.executable !== executable || !sameProcess(service.process, outcome.service) || !recovery || recovery.loaded || recovery.process ||
      !report.desktops.some(desktop => sameProcess(desktop, outcome.desktop)) ||
      !["release-reservation", "retire-recovery"].every(kind => journal.steps?.some((step: any) => step.action?.kind === kind && step.evidence?.kind === "complete"))) {
    throw Error("Adoption participants did not survive verified recovery retirement");
  }
}
