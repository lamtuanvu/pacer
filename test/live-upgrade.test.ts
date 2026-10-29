// test/live-upgrade.test.ts
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fixturePlist, guardPacerArgs, upgradePolicy, upgradeRoot, writeFeed } from "../scripts/live/upgrade";
import { liveRoot, type Session } from "../scripts/live/core";
import { LABEL } from "../src/service";
import { hostTarget, assetFile, sha256Hex } from "../src/update/manifest";
import { tmpDir } from "./helpers";

const session = (extra: Partial<Session> = {}): Session => ({ id: "upgrade-test", root: join(liveRoot, "upgrade-test"), port: 49111, pid: 1, innerPort: 49112, createdAt: "2026-10-29T00:00:00Z", stopped: true, ...extra });
const nonce = "0123456789abcdef0123456789abcdef";

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
  expect(text).not.toContain(`<string>${LABEL}</string>`);
  expect(() => fixturePlist({ ...policy, serviceLabel: LABEL }, "/fixture/bin/pacer")).toThrow("non-fixture service label");
});

test("the release feed matches the updater's manifest and checksum layout", () => {
  const feed = tmpDir(), bytes = Buffer.from("fixture binary");
  writeFeed(feed, "0.13.1", bytes);
  const file = assetFile(hostTarget()!);
  expect(JSON.parse(readFileSync(join(feed, "0.13.1", "manifest.json"), "utf8"))).toMatchObject({ version: "0.13.1", assets: [{ file, size: bytes.length, sha256: sha256Hex(bytes) }] });
  expect(readFileSync(join(feed, "0.13.1", "SHA256SUMS"), "utf8")).toBe(`${sha256Hex(bytes)}  ${file}\n`);
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
