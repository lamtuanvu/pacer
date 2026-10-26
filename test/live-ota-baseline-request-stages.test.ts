import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync, mkdirSync, writeFileSync, realpathSync, chmodSync, symlinkSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { applyStageEdits, overlayPublishedBaseline } from "../scripts/live/ota-baseline-request-stages";
import { createBaselineRequestRecorder } from "../src/update/desktop/fixture-request-stage";
import { main as liveMain } from "../scripts/live/cli";
import { buildOtaFixtures, fixturePairedFrontDoorTarget } from "../scripts/live/ota-build";
import { assertExternalCargoTargetIdentity, validateExternalCargoTarget } from "../scripts/live/ota-external-cargo-target";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const temp = () => { const root = realpathSync(mkdtempSync(join(tmpdir(), "pacer-stage-test-"))); roots.push(root); return root; };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

test("baseline overlay requires exact source hash and each anchor once", () => {
  const source = "head\nroute\ntail\n";
  expect(applyStageEdits(source, digest(source), [["route", "route\nmark"]])).toBe("head\nroute\nmark\ntail\n");
  expect(() => applyStageEdits(source, "0".repeat(64), [["route", "route\nmark"]])).toThrow("Published baseline source changed");
  expect(() => applyStageEdits(source, digest(source), [["missing", "mark"]])).toThrow("Baseline diagnostic anchor changed");
  expect(() => applyStageEdits("route route", digest("route route"), [["route", "mark"]])).toThrow("Baseline diagnostic anchor changed");
});

test("default baseline control remains byte-for-byte unchanged", () => {
  const root = temp();
  const file = join(root, "src", "api", "http.ts");
  mkdirSync(join(root, "src", "api"), { recursive: true });
  writeFileSync(file, "unchanged");
  expect(overlayPublishedBaseline(root, false)).toBeNull();
  expect(readFileSync(file, "utf8")).toBe("unchanged");
  expect(existsSync(join(root, "src/update/desktop/fixture-request-stage.ts"))).toBe(false);
});

test("request stage recorder writes only bounded fixed stages atomically to private evidence", () => {
  const root = temp();
  const ota = join(root, "ota");
  const evidence = join(root, "evidence");
  mkdirSync(ota, { mode: 0o700 });
  mkdirSync(evidence, { mode: 0o700 });
  const record = createBaselineRequestRecorder({ root: ota, uid: process.getuid!() }, () => 1234);
  record("request-arrival");
  record("route-dispatch");
  record("begin-exit");
  const path = join(evidence, "baseline-request-stages.json");
  const body = readFileSync(path, "utf8");
  expect(Buffer.byteLength(body)).toBeLessThanOrEqual(1024);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const parsed = JSON.parse(body);
  expect(Object.keys(parsed).sort()).toEqual(["pid", "schema", "stages"]);
  expect(parsed.pid).toBe(process.pid);
  expect(parsed.stages.map((stage: { stage: string }) => stage.stage)).toEqual(["request-arrival", "route-dispatch", "begin-exit"]);
  expect(body).not.toContain(root);
});

test("request stage recorder refuses a shared evidence directory and never writes elsewhere", () => {
  const root = temp();
  const ota = join(root, "ota");
  const evidence = join(root, "evidence");
  mkdirSync(ota, { mode: 0o700 });
  mkdirSync(evidence, { mode: 0o755 });
  createBaselineRequestRecorder({ root: ota, uid: process.getuid!() }, () => 1234)("request-arrival");
  expect(existsSync(join(evidence, "baseline-request-stages.json"))).toBe(false);
});

test("request stage recorder ignores unknown stages and caps its record", () => {
  const root = temp();
  const ota = join(root, "ota");
  const evidence = join(root, "evidence");
  mkdirSync(ota, { mode: 0o700 });
  mkdirSync(evidence, { mode: 0o700 });
  const record = createBaselineRequestRecorder({ root: ota, uid: process.getuid!() }, () => 1234);
  record("token=secret" as never);
  for (let i = 0; i < 20; i++) record("request-arrival");
  const body = readFileSync(join(evidence, "baseline-request-stages.json"), "utf8");
  expect(JSON.parse(body).stages).toHaveLength(12);
  expect(Buffer.byteLength(body)).toBeLessThanOrEqual(1024);
  expect(body).not.toContain("secret");
});

test("diagnostic baseline variant is restricted to paired Standard build", async () => {
  await expect(buildOtaFixtures("unused", "cert", "paired", false, "Background", true)).rejects.toThrow("Baseline request stages require paired Standard layout");
  await expect(buildOtaFixtures("unused", "cert", "paired", false, "Standard", false, "/tmp/pacer-live-cargo-unused")).rejects.toThrow("External Cargo target requires baseline request stages");
  await expect(liveMain(["ota", "cleanup", "--id", "unused", "--baseline-request-stages"])).rejects.toThrow("Baseline request stages require OTA build");
  await expect(liveMain(["ota", "cleanup", "--id", "unused", "--cargo-target-dir", "/tmp/pacer-live-cargo-unused"])).rejects.toThrow("Unsupported OTA option");
  await expect(liveMain(["ota", "cleanup", "--id", "unused", "--fixture-continue-old-service"])).rejects.toThrow("Fixture old-service choice requires OTA build");
  await expect(buildOtaFixtures("unused", "cert", "paired", true, "Standard", false)).rejects.toThrow("Fixture Standard old-service choice requires paired Standard request stages");
});

test("external Cargo target must be an existing empty private owned directory on a different device", () => {
  const root = temp();
  const parent = join(root, ".work");
  const target = join(parent, "pacer-live-cargo-unit");
  mkdirSync(parent, { mode: 0o700 });
  mkdirSync(target, { mode: 0o700 });
  const device = statSync(root).dev;
  expect(() => validateExternalCargoTarget(target, "unit", device)).toThrow("different filesystem");
  const identity = validateExternalCargoTarget(target, "unit", device + 1);
  expect(identity.path).toBe(target);
  expect(() => assertExternalCargoTargetIdentity(identity)).not.toThrow();
  writeFileSync(join(target, "occupied"), "x");
  expect(() => validateExternalCargoTarget(target, "unit", device + 1)).toThrow("empty");
});

test("external Cargo target refuses symlinks, shared modes and replacement", () => {
  const root = temp();
  const parent = join(root, ".work");
  const target = join(parent, "pacer-live-cargo-unit");
  mkdirSync(parent, { mode: 0o700 });
  mkdirSync(target, { mode: 0o700 });
  const otherDevice = statSync(root).dev + 1;
  chmodSync(parent, 0o755);
  expect(() => validateExternalCargoTarget(target, "unit", otherDevice)).toThrow("private");
  chmodSync(parent, 0o700);
  const identity = validateExternalCargoTarget(target, "unit", otherDevice);
  renameSync(target, target + "-old");
  mkdirSync(target, { mode: 0o700 });
  expect(() => assertExternalCargoTargetIdentity(identity)).toThrow("identity changed");
  rmSync(target, { recursive: true });
  symlinkSync(target + "-old", target);
  expect(() => validateExternalCargoTarget(target, "unit", otherDevice)).toThrow("canonical");
});

test("paired Rust front door uses isolated external Cargo subdirectory when requested", () => {
  expect(fixturePairedFrontDoorTarget("/tmp/lease/candidate", undefined)).toBe("/tmp/lease/candidate/rust-target");
  expect(fixturePairedFrontDoorTarget("/tmp/lease/candidate", "/tmp/owned/pacer-live-cargo-unit")).toBe("/tmp/owned/pacer-live-cargo-unit/front-door");
});
