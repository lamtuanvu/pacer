import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpDir } from "./helpers";
import { REAL_APP_EXECUTABLE, assertRealAppUnchanged, realAppNote, realConsentPath, snapshotRealApp } from "../scripts/live/ota-real-app";

const app = (pid: number, birth = `${pid}:0`) => ({ process: { pid, bootId: "boot", birth }, uid: 501, parentPid: 1, name: "pacer", executable: REAL_APP_EXECUTABLE });

test("the installed app's consent path uses the release identifier under the given home", () => {
  expect(realConsentPath("/home/user")).toBe("/home/user/Library/Application Support/dev.pacer.desktop/consent.json");
});

test("fixture exercises prove the installed app's processes and consent were left alone", () => {
  const home = tmpDir();
  const consent = realConsentPath(home);
  const fixtureDesktop = { ...app(30), executable: "/fixture/.work/live/x/ota/current.app/Contents/MacOS/pacer" };
  expect(snapshotRealApp([fixtureDesktop], home, null).installedAppNotRunning).toBe(true);
  mkdirSync(dirname(consent), { recursive: true });
  writeFileSync(consent, '{"keep":true}');
  const before = snapshotRealApp([app(20), fixtureDesktop, app(10)], home, null);
  expect(before.processes.map(item => item.pid)).toEqual([10, 20]);
  expect(before.consentSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(realAppNote(before)).toContain("Installed app: 2 processes");
  expect(() => assertRealAppUnchanged(before, snapshotRealApp([app(10), app(20)], home, null))).not.toThrow();
  expect(() => assertRealAppUnchanged(before, snapshotRealApp([], home, null))).not.toThrow();
  expect(() => assertRealAppUnchanged(before, snapshotRealApp([app(10), app(20, "reused")], home, null))).toThrow("process changed");
  writeFileSync(consent, '{"keep":false}');
  expect(() => assertRealAppUnchanged(before, snapshotRealApp([app(10), app(20)], home, null))).toThrow("files, service or CLI link changed");
  writeFileSync(consent, '{"keep":true}');
  mkdirSync(join(home, "Library/LaunchAgents"), { recursive: true });
  writeFileSync(join(home, "Library/LaunchAgents/com.pacer.serve.plist"), "job");
  expect(() => assertRealAppUnchanged(before, snapshotRealApp([app(10), app(20)], home, null))).toThrow("files, service or CLI link changed");
  const withJob = snapshotRealApp([app(10)], home, 123);
  expect(() => assertRealAppUnchanged(withJob, snapshotRealApp([app(10)], home, 124))).toThrow("files, service or CLI link changed");
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  symlinkSync("/Applications/pacer.app/Contents/Resources/pacer", join(home, ".local/bin/pacer"));
  expect(snapshotRealApp([], home, null).cliLink?.type).toBe("symlink");
  expect(snapshotRealApp([], home, null).cliLink?.target).toContain("/Applications/pacer.app");
  writeFileSync(join(dirname(consent), "other.json"), "other");
  expect(Object.keys(snapshotRealApp([], home, null).configFiles)).toEqual(["consent.json", "other.json"]);
});
