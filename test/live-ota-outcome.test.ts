import { expect, test } from "bun:test";
import { verifyExerciseOutcome } from "../scripts/live/ota-outcome";
import { createHash } from "node:crypto";
const id = "a".repeat(64), tx = "transaction-one";
const manifest = Buffer.from(JSON.stringify({ binding: { installationId: id, transactionId: tx } }));
function journal(state: string) { const proof = (version: string) => ({ installationId: id, transactionId: tx, desktop: {pid: 41,bootId:"boot",birth:"41"}, service: {pid:42,bootId:"boot",birth:"42"}, nativeSessionId:"session",desktopVersion:version,serviceVersion:version,protocol:3,desktopSignedIn:true,validStateRead:true }); return { state, manifestSha256: createHash("sha256").update(manifest).digest("hex"), verificationProof: proof("0.2.4"), restorationProof: proof("0.2.3") }; }
test("normal upgrade and interrupted precommit restore require matching native journal evidence", () => {
  expect(() => verifyExerciseOutcome("upgrade", id, tx, "complete", manifest, journal("committed"))).not.toThrow();
  expect(() => verifyExerciseOutcome("interrupted-install", id, tx, "restored", manifest, journal("restored"))).not.toThrow();
  expect(() => verifyExerciseOutcome("interrupted-install", id, tx, "complete", manifest, journal("committed"))).toThrow();
});
test("public completion, stale journal, mismatched transaction and missing proofs are insufficient", () => {
  for (const value of [{ ...journal("committed"), manifestSha256: "b".repeat(64) }, { ...journal("committed"), verificationProof: null }, journal("verifying")]) expect(() => verifyExerciseOutcome("upgrade", id, tx, "complete", manifest, value)).toThrow();
  expect(() => verifyExerciseOutcome("upgrade", id, "other", "complete", manifest, journal("committed"))).toThrow();
  expect(() => verifyExerciseOutcome("upgrade", "b".repeat(64), tx, "complete", manifest, journal("committed"))).toThrow();
});
test("only deliberate restoration failure may use offline terminal evidence", () => {
  expect(() => verifyExerciseOutcome("restore-failure", id, tx, undefined, manifest, journal("recovery-failed"))).not.toThrow();
  for (const scenario of ["upgrade", "startup-failure", "helper-crash", "interrupted-install"]) expect(() => verifyExerciseOutcome(scenario, id, tx, undefined, manifest, journal("recovery-failed"))).toThrow();
  expect(() => verifyExerciseOutcome("restore-failure", id, tx, undefined, manifest, journal("restoring"))).toThrow();
  expect(() => verifyExerciseOutcome("restore-failure", id, tx, "complete", manifest, journal("recovery-failed"))).toThrow();
});

test("terminal recovery must leave the proved desktop and service alive after recovery job retirement", async () => {
  const { verifyExerciseSurvivors } = await import("../scripts/live/ota-outcome");
  const value = {...journal("restored"),steps:[{action:{kind:"release-reservation"},evidence:{kind:"complete"}},{action:{kind:"retire-recovery"},evidence:{kind:"complete"}}]};
  const report = {desktops:[value.restorationProof.desktop],jobs:[{label:"service",loaded:true,process:value.restorationProof.service},{label:"recovery",loaded:false,process:null}]};
  expect(() => verifyExerciseSurvivors(value, report, "service", "recovery")).not.toThrow();
  for(const changed of [
    {...report,desktops:[]},
    {...report,desktops:[{...value.restorationProof.desktop,birth:"reused"}]},
    {...report,jobs:[{...report.jobs[0],process:{...value.restorationProof.service,birth:"reused"}},report.jobs[1]]},
    {...report,jobs:[report.jobs[0],{...report.jobs[1],loaded:true}]},
  ]) expect(() => verifyExerciseSurvivors(value,changed,"service","recovery")).toThrow();
  expect(() => verifyExerciseSurvivors({...value,steps:value.steps.slice(0,1)},report,"service","recovery")).toThrow();
});
