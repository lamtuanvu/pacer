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
for (const [scenario, points] of Object.entries({ upgrade: [], "startup-failure": ["candidate-startup"], "helper-crash": ["authorized"], "interrupted-install": ["installed"], "restore-failure": ["candidate-startup", "restore"], adopt: [], "adopt-failure": ["adoption-startup"], attached: [] })) {
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
