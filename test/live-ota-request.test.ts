import { expect, test } from "bun:test";
import { fixtureRequest, permitsFixtureRequest, retryFixtureRevision } from "../scripts/live/ota-request";
import { ApiError } from "../src/api/client-types";
import { newExercise } from "../scripts/live/ota-exercise-record";
const driver = { pid: 42, bootId: "boot", birth: "birth" }, installationId = "a".repeat(64);
test("restart retries an explicit pre-mutation native-session rejection only when requested", async () => {
  const error = new ApiError("not_allowed", "Verified desktop update connection is unavailable");
  let attempts = 0, cleared = 0, waits = 0;
  await retryFixtureRevision(async () => { if (++attempts === 1) throw error; }, () => { cleared++; }, async () => { waits++; });
  expect([attempts, cleared, waits]).toEqual([2, 1, 1]);
  await expect(retryFixtureRevision(async () => { throw error; }, () => {})).rejects.toBe(error);
  await expect(retryFixtureRevision(async () => { throw new ApiError("not_allowed", "Other refusal"); }, () => {}, async () => {})).rejects.toThrow("Other refusal");
});
test("fixture retries only confirmed revision rejections and retains uncertain requests", async () => {
  let attempts = 0, cleared = 0;
  const conflict = new ApiError("conflict", "Desktop update conflict: revision changed");
  await retryFixtureRevision(async () => { if (++attempts < 3) throw conflict; }, () => { cleared++; });
  expect([attempts, cleared]).toEqual([3, 2]);
  for (const error of [new Error("connection lost"), new ApiError("conflict", "already installing"), new ApiError("internal", conflict.message)]) {
    attempts = 0; cleared = 0;
    await expect(retryFixtureRevision(async () => { attempts++; throw error; }, () => { cleared++; })).rejects.toBe(error);
    expect([attempts, cleared]).toEqual([1, 0]);
  }
  attempts = 0; cleared = 0;
  await expect(retryFixtureRevision(async () => { attempts++; throw conflict; }, () => { cleared++; })).rejects.toBe(conflict);
  expect([attempts, cleared]).toEqual([5, 5]);
});
test("fixture retries a confirmed adoption conflict after waiting for a fresh offer", async () => {
  const conflict = new ApiError("conflict", "Desktop service adoption changed");
  let attempts = 0, cleared = 0, waits = 0;
  await retryFixtureRevision(async () => { if (++attempts === 1) throw conflict; }, () => { cleared++; }, undefined, async () => { waits++; });
  expect([attempts, cleared, waits]).toEqual([2, 1, 1]);
  attempts = 0;
  await expect(retryFixtureRevision(async () => { attempts++; throw conflict; }, () => {})).rejects.toBe(conflict);
  expect(attempts).toBe(1);
});
function fixture() {
  const params = { installationId, requestId: "request-one", expectRevision: 3 };
  const request = fixtureRequest("desktop.update.check", params);
  return { params, exercise: { ...newExercise("upgrade", driver, installationId), state: "running" as const }, runtime: { schema: 1 as const, driver, sourceService: driver, desktop: driver, state: "managed" as const, request } };
}
test("only exact recorded fixed request and live driver is admitted", () => {
  const f = fixture();
  expect(permitsFixtureRequest(f, "POST", "/v3/ops/desktop.update.check", { expectRevision: 3, requestId: "request-one", installationId }, driver)).toBe(true);
  for (const [method, path, params, identity] of [
    ["POST", "/v2/ops/desktop.update.check", f.params, driver],
    ["POST", "/v3/ops/desktop.update.download", f.params, driver],
    ["POST", "/v3/ops/desktop.update.check", { ...f.params, expectRevision: 4 }, driver],
    ["POST", "/v3/ops/desktop.update.check", { ...f.params, arbitrary: true }, driver],
    ["POST", "/v3/ops/desktop.update.check", f.params, { ...driver, birth: "reused" }],
    ["POST", "/v3/ops/desktop.update.check", f.params, null],
  ] as const) expect(permitsFixtureRequest(f, method, path, params, identity)).toBe(false);
  expect(permitsFixtureRequest({ ...f, runtime: { ...f.runtime, request: null } }, "POST", "/v3/ops/desktop.update.check", f.params, driver)).toBe(false);
});
test("request schemas exclude native authority and arbitrary operation parameters", () => {
  const p = fixture().params;
  for (const [op, params] of [["service.install", p], ["desktop.update.adoptCancel", p], ["desktop.update.adopt", { ...p, target: "/tmp/pacer" }], ["desktop.update.restart", p], ["desktop.update.restart", { ...p, version: "0.2.4", clientId: "foreign" }], ["desktop.update.configure", { ...p, autoDownload: "yes" }]]) expect(() => fixtureRequest(op as string, params)).toThrow();
  expect(fixtureRequest("desktop.update.restart", { ...p, version: "0.2.4" }).requestId).toBe(p.requestId);
  expect(fixtureRequest("desktop.update.adopt", p).op).toBe("desktop.update.adopt");
});

test("proxy fixture gate refuses missing leases and unsupported writes before native inspection", async () => {
  const { authorizeFixtureRequest } = await import("../scripts/live/ota-request");
  const session = { id: "absent", root: "/missing-fixture", pid: 42, port: 49900, innerPort: 49901, createdAt: "now" };
  for (const op of ["service.install", "desktop.update.adopt", "desktop.update.check"]) {
    expect(await authorizeFixtureRequest(session, new Request(`http://127.0.0.1:49900/v3/ops/${op}`, { method: "POST", body: JSON.stringify(fixture().params) }))).toBe(false);
  }
});
