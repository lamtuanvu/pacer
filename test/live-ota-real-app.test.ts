import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tmpDir } from "./helpers";
import { REAL_APP_EXECUTABLE, assertRealAppUnchanged, realAppNote, realConsentPath, snapshotRealApp } from "../scripts/live/ota-real-app";

const app = (pid: number, birth = `${pid}:0`) => ({ process: { pid, bootId: "boot", birth }, uid: 501, parentPid: 1, name: "pacer", executable: REAL_APP_EXECUTABLE });

test("the installed app's consent path uses the release identifier under the given home", () => {
  expect(realConsentPath("/home/user")).toBe("/home/user/Library/Application Support/dev.pacer.desktop/consent.json");
});

test("fixture exercises prove the installed app's processes and consent were left alone", () => {
  const consent = realConsentPath(tmpDir());
  const fixtureDesktop = { ...app(30), executable: "/fixture/.work/live/x/ota/current.app/Contents/MacOS/pacer" };
  expect(snapshotRealApp([fixtureDesktop], consent)).toEqual({ processes: [], consentSha256: null });
  mkdirSync(dirname(consent), { recursive: true });
  writeFileSync(consent, '{"keep":true}');
  const before = snapshotRealApp([app(20), fixtureDesktop, app(10)], consent);
  expect(before.processes.map(item => item.pid)).toEqual([10, 20]);
  expect(before.consentSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(realAppNote(before)).toBe("Installed app: 2 processes, consent file present; both unchanged.");
  expect(() => assertRealAppUnchanged(before, snapshotRealApp([app(10), app(20)], consent))).not.toThrow();
  expect(() => assertRealAppUnchanged(before, snapshotRealApp([app(10)], consent))).toThrow("process changed");
  expect(() => assertRealAppUnchanged(before, snapshotRealApp([app(10), app(20, "reused")], consent))).toThrow("process changed");
  writeFileSync(consent, '{"keep":false}');
  expect(() => assertRealAppUnchanged(before, snapshotRealApp([app(10), app(20)], consent))).toThrow("consent file changed");
});
