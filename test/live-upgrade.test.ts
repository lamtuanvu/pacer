// test/live-upgrade.test.ts
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertUpgradeFixtureLease, fixturePlist, guardPacerArgs, stageUpgradeRuntime, UPGRADE_BUILDS, upgradePolicy, upgradeRoot, upgradeRuntimeDir, upgradeLoginArgs, handoverFailureMarker, writeFeed } from "../scripts/live/upgrade";
import { liveRoot, type Session } from "../scripts/live/core";
import { LABEL } from "../src/service";
import { consumeFixtureHandoverFailure, recoverFixtureHandover } from "../src/service/upgrade";
import { hostTarget, assetFile, sha256Hex } from "../src/update/manifest";
import { tmpDir } from "./helpers";

const session = (extra: Partial<Session> = {}): Session => ({ id: "upgrade-test", root: join(liveRoot, "upgrade-test"), port: 49111, pid: 1, innerPort: 49112, createdAt: "2026-10-29T00:00:00Z", stopped: true, ...extra });
const nonce = "0123456789abcdef0123456789abcdef";

test("every upgrade CLI identity must match the sealed native fixture lease", () => {
  const policy = upgradePolicy(session(), nonce, 501);
  const sealed = { schema: 1, phase: "prepared", root: policy.root, nonce: policy.nonce, pacerHome: policy.home,
    innerPort: policy.port, currentApp: policy.currentApp, serviceLabel: policy.serviceLabel,
    recoveryLabel: policy.recoveryLabel, ownerUid: policy.uid };
  const fixturePolicySha256 = createHash("sha256").update(JSON.stringify(policy)).digest("hex");
  for (const { version } of Object.values(UPGRADE_BUILDS)) {
    const identity = { version, arch: "aarch64", fixture: true, otaMode: "fixture", fixturePolicySha256 };
    expect(() => assertUpgradeFixtureLease(policy, sealed, identity, version, "aarch64")).not.toThrow();
    expect(() => assertUpgradeFixtureLease(policy, sealed, { ...identity, fixturePolicySha256: "0".repeat(64) }, version, "aarch64")).toThrow("sealed native lease");
    expect(() => assertUpgradeFixtureLease(policy, { ...sealed, innerPort: policy.port + 1 }, identity, version, "aarch64")).toThrow("sealed native lease");
  }
});

test("each upgrade build stages its CLI and native shim beside one another", () => {
  const root = tmpDir(), shim = join(root, "libpacer-native.dylib");
  writeFileSync(shim, "shim");
  for (const name of ["prefeature", "baseline", "candidate"]) {
    const source = join(root, `${name}-source`), staged = join(root, name);
    writeFileSync(source, name);
    stageUpgradeRuntime(staged, source, shim);
    expect(readFileSync(join(staged, "pacer"), "utf8")).toBe(name);
    expect(readFileSync(join(staged, "libpacer-native.dylib"), "utf8")).toBe("shim");
    expect(existsSync(join(staged, "pacer-core"))).toBe(false);
  }
});

test("the launchd runtime lives inside the compiled native fixture root", () => {
  const policy = upgradePolicy(session(), nonce, 501);
  expect(upgradeRuntimeDir(upgradeRoot(session(), "darwin"))).toBe(join(policy.root, "bin"));
});

test("the harness needs an unseeded, stopped macOS sandbox", () => {
  expect(upgradeRoot(session(), "darwin")).toBe(join(liveRoot, "upgrade-test", "upgrade"));
  expect(() => upgradeRoot(session({ seed: "ui" }), "darwin")).toThrow("unseeded sandbox");
  expect(() => upgradeRoot(session({ stopped: false }), "darwin")).toThrow("stopped");
  expect(() => upgradeRoot(session(), "linux")).toThrow("need macOS");
});

test("the fixture policy and plist use the fixture label, never the real one", () => {
  const policy = upgradePolicy(session(), nonce, 501);
  expect(policy.serviceLabel).toBe(`com.pacer.live.${nonce}.service`);
  expect(policy).toMatchObject({ home: join(liveRoot, "upgrade-test", "home"), port: 49112, root: join(liveRoot, "upgrade-test", "ota") });
  const text = fixturePlist(policy, "/fixture/bin/pacer");
  expect(text).toContain(`<key>Label</key><string>${policy.serviceLabel}</string>`);
  expect(text).toContain("<key>PACER_RELEASE_BASE</key>");
  expect(text).not.toContain(`<string>${LABEL}</string>`);
  expect(() => fixturePlist({ ...policy, serviceLabel: LABEL }, "/fixture/bin/pacer")).toThrow("non-fixture service label");
});

test("the release feed matches the updater's manifest and checksum layout", () => {
  const feed = tmpDir(), bytes = Buffer.from("fixture binary");
  writeFeed(feed, "0.13.1", bytes);
  const file = assetFile(hostTarget()!);
  expect(JSON.parse(readFileSync(join(feed, "0.13.1", "manifest.json"), "utf8"))).toMatchObject({ version: "0.13.1", assets: [{ file, size: bytes.length, sha256: sha256Hex(bytes) }] });
  expect(readFileSync(join(feed, "0.13.1", "SHA256SUMS"), "utf8")).toBe(`${sha256Hex(bytes)}  ${file}\n`);
  expect(JSON.parse(readFileSync(join(feed, "latest.json"), "utf8"))).toEqual({ version: "0.13.1" });
});

test("the pre-feature build never reaches its own launchd code", () => {
  expect(() => guardPacerArgs("prefeature", ["update", "--to", "0.13.1", "--no-reinstall"])).toThrow("--no-restart");
  expect(() => guardPacerArgs("prefeature", ["update", "--to", "0.13.1", "--no-reinstall", "--no-restart"])).not.toThrow();
  expect(() => guardPacerArgs("candidate", ["update", "--to", "0.13.0"])).toThrow("--no-reinstall");
  expect(() => guardPacerArgs("candidate", ["update", "--to", "0.13.0", "--no-reinstall"])).not.toThrow();
  for (const cmd of ["service", "uninstall", "install", "init", "setup", "open"]) expect(() => guardPacerArgs("candidate", [cmd])).toThrow("live upgrade refuses");
  expect(() => guardPacerArgs("prefeature", ["delegate", "--goal", "x"])).not.toThrow();
  for (const args of [["api", "call", "update.apply"], ["dashboard"], ["login"], ["app"], ["update", "--no-restart", "--no-reinstall", "--to", "0.13.1", "--and-service"]])
    expect(() => guardPacerArgs("prefeature", args)).toThrow();
  expect(() => guardPacerArgs("prefeature", ["status"])).not.toThrow();
});

test("upgrade login opens only a feature fixture on the requested screen", () => {
  expect(upgradeLoginArgs("baseline", "settings")).toEqual(["open", "--print", "settings"]);
  expect(upgradeLoginArgs("candidate", undefined)).toEqual(["open", "--print"]);
  expect(() => upgradeLoginArgs("prefeature", "settings")).toThrow("pre-feature");
  expect(() => upgradeLoginArgs("baseline", "https://example.test/")).toThrow("screen");
});

test("forced handover failure marker is confined to the upgrade fixture lease", () => {
  const policy = upgradePolicy(session(), nonce, 501);
  expect(handoverFailureMarker(policy)).toBe(join(policy.root, "handover-fail-once"));
  expect(() => handoverFailureMarker({ ...policy, serviceLabel: LABEL })).toThrow("fixture");
  const root = tmpDir(), marker = join(root, "handover-fail-once");
  writeFileSync(marker, "1\n");
  expect(consumeFixtureHandoverFailure(root)).toBe(true);
  expect(consumeFixtureHandoverFailure(root)).toBe(false);
});

test("restart recovery consumes the fixture failure once before handover", async () => {
  const root = tmpDir(), marker = join(root, "handover-fail-once");
  const fixture = { ...upgradePolicy(session(), nonce, 501), root };
  let calls = 0;
  writeFileSync(marker, "1\n");
  await expect(recoverFixtureHandover(fixture.home, fixture, async () => { calls++; return "handed over"; })).rejects.toThrow("Forced fixture handover failure");
  expect(calls).toBe(0);
  expect(await recoverFixtureHandover(fixture.home, fixture, async () => { calls++; return "handed over"; })).toBe("handed over");
  expect(calls).toBe(1);
  writeFileSync(marker, "1\n");
  expect(await recoverFixtureHandover("/other-home", fixture, async () => "untouched")).toBe("untouched");
  expect(existsSync(marker)).toBe(true);
});
