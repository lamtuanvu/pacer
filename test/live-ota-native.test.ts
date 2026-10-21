import { expect, test } from "bun:test";
import { validateFixtureIdentity, fixtureInstallation } from "../scripts/live/ota-native";
import { installationFingerprint } from "../src/update/desktop/identity";
import { createHash } from "node:crypto";
import { otaFixturePolicy, type OtaRecord } from "../scripts/live/ota";
const state = { nativeFixture: { arch: "aarch64", updaterKeySha256: "b".repeat(64) }, ownerUid: 501, root: "/fixture/ota", nonce: "c".repeat(32), pacerHome: "/fixture/home", innerPort: 49990, currentApp: "/fixture/ota/current.app", serviceLabel: "fixture-service", recoveryLabel: "fixture-recovery" } as OtaRecord;
test("compiled fixture identity binds exact role, policy, key, version and CPU", () => {
  const value = { schema: 1, role: "update-helper", bundleId: "dev.pacer.desktop", version: "0.2.3", arch: "aarch64", fixture: true, otaMode: "fixture", fixturePolicySha256: createHash("sha256").update(JSON.stringify(otaFixturePolicy(state))).digest("hex"), updaterKeySha256: "b".repeat(64) };
  expect(() => validateFixtureIdentity(state, value, "helper", "0.2.3")).not.toThrow();
  for (const patch of [{ fixture: false }, { otaMode: "production" }, { version: "0.2.4" }, { role: "cli" }, { updaterKeySha256: "a".repeat(64) }, { fixturePolicySha256: "a".repeat(64) }, { arch: "x86_64" }]) expect(() => validateFixtureIdentity(state, { ...value, ...patch }, "helper", "0.2.3")).toThrow();
});
test("installation binding requires exact service executable, loaded incarnation and registration receipt", () => {
  const executable = state.currentApp + "/Contents/Resources/pacer", registrationText = "exact receipt", process = { pid: 42, bootId: "boot", birth: "birth" };
  const job = { label: state.serviceLabel, state: "loaded" as const, loaded: true, process, executable, registrationText, registrationSha256: createHash("sha256").update(registrationText).digest("hex") };
  const result = fixtureInstallation(state, { schema: 1, desktops: [], jobs: [job] }, "0.2.3");
  expect(result.id).toBe(installationFingerprint(result, executable, registrationText));
  for (const patch of [{ executable: "/foreign" }, { loaded: false }, { process: null }, { registrationSha256: "a".repeat(64) }, { label: "foreign" }]) expect(() => fixtureInstallation(state, { schema: 1, desktops: [], jobs: [{ ...job, ...patch }] }, "0.2.3")).toThrow();
});

test("fixture ownership follows the exact registered program", () => {
  const registrationText = "external receipt", process = { pid: 43, bootId: "boot", birth: "birth" };
  const job = { label: state.serviceLabel, state: "loaded" as const, loaded: true, process, executable: state.root + "/external/pacer", registrationText, registrationSha256: createHash("sha256").update(registrationText).digest("hex") };
  const attached = fixtureInstallation(state, { schema: 1, desktops: [], jobs: [job] }, "0.2.3");
  expect(attached.ownership).toBe("attached");
  expect(attached.id).toBe(installationFingerprint(attached, job.executable, registrationText));
  expect(() => fixtureInstallation(state, { schema: 1, desktops: [], jobs: [job] }, "0.2.3", "managed")).toThrow();
  const managed = fixtureInstallation(state, { schema: 1, desktops: [], jobs: [{ ...job, executable: state.currentApp + "/Contents/Resources/pacer" }] }, "0.2.3", "managed");
  expect(managed.ownership).toBe("managed");
  expect(managed.id).not.toBe(attached.id);
  expect(() => fixtureInstallation(state, { schema: 1, desktops: [], jobs: [{ ...job, executable: state.root + "/other/pacer" }] }, "0.2.3")).toThrow();
});

test("desktop fixture must prove compiled isolation before launch", () => {
  const identity = { schema: 1, role: "desktop", bundleId: "dev.pacer.desktop", version: "0.2.3", arch: "aarch64", fixture: true, otaMode: "fixture", fixturePolicySha256: createHash("sha256").update(JSON.stringify(otaFixturePolicy(state))).digest("hex"), updaterKeySha256: "b".repeat(64) };
  expect(() => validateFixtureIdentity(state, identity, "desktop", "0.2.3")).toThrow();
  expect(() => validateFixtureIdentity(state, { ...identity, fixtureIsolationProtocol: 1 }, "desktop", "0.2.3")).not.toThrow();
});

test("fixtures model a user who already consented to first-run setup", async () => {
  const { seedFixtureConsent } = await import("../scripts/live/ota-native");
  const { tmpDir } = await import("./helpers");
  const { readFileSync, statSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const home = tmpDir(), file = join(home, "Library/Application Support/dev.pacer.desktop/consent.json");
  seedFixtureConsent({ pacerHome: home, currentApp: "/fixture/ota/current.app" });
  expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ path: false, keep: false });
  expect((await import("node:fs")).readlinkSync(join(home, ".local/bin/pacer"))).toBe("/fixture/ota/current.app/Contents/Resources/pacer");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  writeFileSync(file, JSON.stringify({ at: "x", path: false, keep: true }));
  seedFixtureConsent({ pacerHome: home, currentApp: "/fixture/ota/current.app" });
  expect(JSON.parse(readFileSync(file, "utf8")).keep).toBe(true);
});
