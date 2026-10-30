import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpDir } from "./helpers";
import { REAL_APP_EXECUTABLE, assertRealAppUnchanged, realAppNote, realConsentPath, snapshotRealApp } from "../scripts/live/ota-real-app";
import { realAppEvidencePair } from "../scripts/live/ota-exercise";

const app = (pid: number, birth = `${pid}:0`) => ({ process: { pid, bootId: "boot", birth }, uid: 501, parentPid: 1, name: "pacer", executable: REAL_APP_EXECUTABLE });

test("the installed app's consent path uses the release identifier under the given home", () => {
  expect(realConsentPath("/home/user")).toBe("/home/user/Library/Application Support/dev.pacer.desktop/consent.json");
});

test("a resumed exercise keeps the first real-app snapshots and chooses a new pair", () => {
  const root = tmpDir(), evidence = join(root, "evidence");
  mkdirSync(evidence);
  const first = realAppEvidencePair(root, false);
  writeFileSync(first.before, "first before");
  writeFileSync(first.after, "first after");
  const resume = realAppEvidencePair(root, true);
  expect(resume.before).toBe(join(evidence, "real-app-before.resume-1.json"));
  expect(resume.after).toBe(join(evidence, "real-app-after.resume-1.json"));
  writeFileSync(resume.before, "second before");
  expect(realAppEvidencePair(root, true).before).toBe(join(evidence, "real-app-before.resume-2.json"));
  expect(readFileSync(first.before, "utf8")).toBe("first before");
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
  expect(realAppNote(before, snapshotRealApp([], home, null))).toContain("exited during exercise");
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
  writeFileSync(join(dirname(consent), ".window-state.json"), "changing window state");
  writeFileSync(join(dirname(consent), "cli-choice.json"), "changing choice");
  writeFileSync(join(dirname(consent), "takeover-acknowledged.json"), "changing acknowledgement");
  writeFileSync(join(dirname(consent), "takeover-dismissed.json"), "changing dismissal");
  expect(Object.keys(snapshotRealApp([], home, null).configFiles)).toEqual(["cli-choice.json", "consent.json", "other.json", "takeover-acknowledged.json", "takeover-dismissed.json"]);
  mkdirSync(join(dirname(consent), "nested"));
  writeFileSync(join(dirname(consent), "nested/.window-state.json"), "nested state");
  expect(snapshotRealApp([], home, null).configFiles["nested/.window-state.json"]).toMatch(/^[a-f0-9]{64}$/);
});
