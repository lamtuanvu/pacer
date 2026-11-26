import { expect, test } from "bun:test";
import { exerciseSchema, newExercise, resumableStartup } from "../scripts/live/ota-exercise-record";
const driver = { pid: 42, bootId: "boot", birth: "birth" };
const id = "a".repeat(64);
test("startup retry requires no exercise, no request, and every former participant exited", () => {
  const runtime = { schema: 1 as const, state: "starting" as const, driver, sourceService: { ...driver, pid: 43 }, desktop: { ...driver, pid: 44 }, request: null };
  expect(resumableStartup(runtime, null, () => true)).toBe(true);
  for (const pid of [42, 43, 44]) expect(resumableStartup(runtime, null, value => value.pid !== pid)).toBe(false);
  expect(resumableStartup(runtime, newExercise("upgrade", driver, id), () => true)).toBe(false);
  expect(resumableStartup({ ...runtime, state: "managed" }, null, () => true)).toBe(false);
  expect(resumableStartup({ ...runtime, desktop: null }, null, () => true)).toBe(false);
  expect(resumableStartup({ ...runtime, request: { op: "desktop.update.check", requestId: "pending", paramsSha256: "a".repeat(64) } }, null, () => true)).toBe(false);
});
for (const [scenario, points] of Object.entries({
  upgrade: [], "startup-failure": ["candidate-startup"], "helper-crash": ["authorized"], "interrupted-install": ["installed"], "restore-failure": ["candidate-startup", "restore"],
  adopt: [], "adopt-failure": ["adoption-startup"], attached: [],
  takeover: [], "takeover-relink": [], "takeover-dismiss": [], "takeover-failure": ["takeover-startup"], "takeover-crash": ["takeover-switch"],
  "consent-use-app": [], "consent-plain-existing": [], "consent-use-app-busy": [], "consent-use-app-dismiss": [], "consent-use-app-restart": [],
  "consent-gone-formula": [],
  "own-link-repair": [], "own-link-repair-failure": ["own-link-bootstrap"],
})) {
  test(`fixed ${scenario} fault points`, () => {
    const record = newExercise(scenario, driver, id);
    expect(record.faults.map(f => String(f.point))).toEqual(points);
    expect(record.state).toBe("armed");
    expect(record.transactionId).toBeNull();
    expect(exerciseSchema.parse(record)).toEqual(record);
  });
}
test("unknown scenarios, malformed markers and foreign receipt transactions refuse", () => {
  expect(() => newExercise("wrong-service", driver, id)).toThrow();
  const adopt = newExercise("adopt", driver, id); (adopt.faults as any[]).push({ point: "adoption-startup", consumed: null });
  expect(() => exerciseSchema.parse(adopt)).toThrow();
  for (const mutate of [
    (v: any) => delete v.transactionId,
    (v: any) => delete v.faults[0].consumed,
    (v: any) => v.faults.reverse(),
    (v: any) => v.installationId = "ota-placeholder",
    (v: any) => v.faults[0].consumed = { process: driver, transactionId: "tx" },
    (v: any) => { v.transactionId = "tx"; v.faults[1].consumed = { process: driver, transactionId: "tx" }; },
    (v: any) => v.command = "arbitrary",
  ]) {
    const value = newExercise("restore-failure", driver, id); mutate(value);
    expect(() => exerciseSchema.parse(value)).toThrow();
  }
});

test("active-work scenarios: fixed fault points and expected outcomes", async () => {
  const { managedExpectedPhase, newExercise, ACTIVE_WORK_SCENARIOS, MANAGED_SCENARIOS } = await import("../scripts/live/ota-exercise-record");
  const driver = { pid: 4242, bootId: "boot", birth: "1:2" }, installation = "a".repeat(64);
  expect(ACTIVE_WORK_SCENARIOS.every(name => (MANAGED_SCENARIOS as readonly string[]).includes(name))).toBe(true);
  expect(newExercise("active-work", driver, installation).faults).toEqual([]);
  expect(newExercise("active-work-rollback", driver, installation).faults).toEqual([{ point: "candidate-startup", consumed: null }]);
  expect(newExercise("active-work-foreign", driver, installation).faults).toEqual([]);
  expect(managedExpectedPhase("active-work")).toBe("complete");
  expect(managedExpectedPhase("active-work-rollback")).toBe("restored");
  expect(managedExpectedPhase("active-work-foreign")).toBeNull();
  expect(managedExpectedPhase("upgrade")).toBe("complete");
  expect(managedExpectedPhase("restore-failure")).toBe("recovery-failed");
});

test("survivor reservation evidence needs the admitted flag and only survivor leases", async () => {
  const { assertSurvivorReservation } = await import("../scripts/live/ota-active-work");
  const sample = (over: object) => ({ at: "t", reservation: "tx", survivors: true, leases: 2, survivorLeases: 2, ...over });
  expect(() => assertSurvivorReservation([sample({})], "tx")).not.toThrow();
  for (const bad of [{ survivors: false }, { reservation: "other" }, { survivorLeases: 1 }, { survivorLeases: 0, leases: 0 }]) {
    expect(() => assertSurvivorReservation([sample(bad)], "tx")).toThrow("No survivor reservation");
  }
});

test("handover evidence: one commit run that kept the sessions; failures and second signals refuse", async () => {
  const { handoverRuns, assertOneHandover } = await import("../scripts/live/ota-active-work");
  const commit = "pacer: handover (commit): signalled=0; Updated to v0.2.4. 0 tasks and 2 sessions kept running; 0 stayed on the previous runner.";
  const request = "pacer: handover (request): signalled=0; Updated to v0.2.4. 0 tasks and 2 sessions kept running; 0 stayed on the previous runner.";
  expect(assertOneHandover(handoverRuns(["noise", commit, request]), true, 2)?.origin).toBe("commit");
  // The old "desktop update handover failed" shape and the new failure lines never count.
  expect(handoverRuns(["pacer: desktop update handover failed: boom"]).runs).toEqual([]);
  expect(() => assertOneHandover(handoverRuns([commit, "pacer: handover (commit) failed: boom"]), true, 2)).toThrow("failed");
  expect(() => assertOneHandover(handoverRuns([]), true, 2)).toThrow("one commit handover");
  expect(() => assertOneHandover(handoverRuns([commit, commit]), true, 2)).toThrow("one commit handover");
  expect(() => assertOneHandover(handoverRuns([commit]), true, 3)).toThrow("surviving sessions");
  expect(() => assertOneHandover(handoverRuns([commit, request.replace("signalled=0", "signalled=1")]), true, 2)).toThrow("second time");
  expect(assertOneHandover(handoverRuns([]), false, 2)).toBeNull();
  expect(() => assertOneHandover(handoverRuns([request]), false, 2)).toThrow("rolled-back");
});

test("coverage refusal evidence distinguishes the lease-tree rule from an out-of-tree foreign path", async () => {
  const { coverageRefusals } = await import("../scripts/live/ota-active-work");
  expect(coverageRefusals([
    "pacer: desktop update coverage service=3 lease=2 foreign=1",
    "pacer: desktop update coverage refused: foreign=1 lease-tree=0",
    "pacer: desktop update coverage refused: foreign=2 lease-tree=1",
  ])).toEqual([{ foreign: 1, leaseTree: 0 }, { foreign: 2, leaseTree: 1 }]);
});
