import { createHash } from "node:crypto";
import { readinessProofSchema } from "../../src/update/desktop/native-record";
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
