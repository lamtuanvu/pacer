import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { verifyAdoptionOutcome, verifyAdoptionSurvivors } from "../scripts/live/ota-outcome";
const old = "a".repeat(64), next = "b".repeat(64), tx = "adoption-1";
const service = { pid: 10, bootId: "boot", birth: "1" }, desktop = { pid: 11, bootId: "boot", birth: "2" };
const manifest = Buffer.from(JSON.stringify({ transactionKind: "adoption", binding: { installationId: old, transactionId: tx }, expectedNewInstallationId: next }));
const proof = (branch: string, resulting: string) => ({ installationId: old, transactionId: tx, resultingInstallationId: resulting, branch, desktop, nativeSessionId: "s", desktopVersion: "0.2.3", service, serviceVersion: "0.2.3", protocol: 3, desktopSignedIn: true, validStateRead: true });
const journal = (state: string) => ({ transactionKind: "adoption", state, manifestSha256: createHash("sha256").update(manifest).digest("hex"),
  verificationProof: state === "committed" ? proof("managed", next) : null, restorationProof: state === "restored" ? proof("original", old) : null,
  steps: ["release-reservation", "retire-recovery"].map(kind => ({ action: { kind }, evidence: { kind: "complete" } })) });
test("adoption outcome binds journal, manifest, branch and resulting installation", () => {
  expect(verifyAdoptionOutcome("adopt", old, tx, "committed", manifest, journal("committed")).resultingInstallationId).toBe(next);
  expect(verifyAdoptionOutcome("adopt-failure", old, tx, "restored", manifest, journal("restored")).branch).toBe("original");
  expect(() => verifyAdoptionOutcome("adopt", old, tx, "restored", manifest, journal("committed"))).toThrow();
  expect(() => verifyAdoptionOutcome("adopt", old, "other", "committed", manifest, journal("committed"))).toThrow();
  expect(() => verifyAdoptionOutcome("adopt-failure", old, tx, "restored", manifest, { ...journal("restored"), restorationProof: proof("managed", old) })).toThrow();
  expect(() => verifyAdoptionOutcome("adopt", old, tx, "committed", manifest, { ...journal("committed"), manifestSha256: "0".repeat(64) })).toThrow();
  expect(() => verifyAdoptionOutcome("attached", old, tx, "committed", manifest, journal("committed"))).toThrow();
});
test("adoption survivors require the proven service program, Desktop and retired recovery", () => {
  const outcome = verifyAdoptionOutcome("adopt", old, tx, "committed", manifest, journal("committed"));
  const report = { desktops: [desktop], jobs: [{ label: "svc", loaded: true, process: service, executable: "/app/pacer" }, { label: "rec", loaded: false, process: null, executable: null }] };
  verifyAdoptionSurvivors(journal("committed"), outcome, report, "svc", "rec", "/app/pacer");
  expect(() => verifyAdoptionSurvivors(journal("committed"), outcome, report, "svc", "rec", "/external/pacer")).toThrow();
  expect(() => verifyAdoptionSurvivors(journal("committed"), outcome, { ...report, desktops: [] }, "svc", "rec", "/app/pacer")).toThrow();
  expect(() => verifyAdoptionSurvivors({ ...journal("committed"), steps: [] }, outcome, report, "svc", "rec", "/app/pacer")).toThrow();
});
