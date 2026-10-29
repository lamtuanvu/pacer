/** Read-only proof that a native fixture exercise left the user's installed app alone. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { RELEASE_IDENTIFIERS } from "../../src/update/desktop/bundle-identity";
import type { NativeProcess } from "../../src/update/desktop/native-os";
import { sameProcess, type ProcessIdentity } from "../../src/update/desktop/process-identity";

export const REAL_APP_EXECUTABLE = "/Applications/pacer.app/Contents/MacOS/pacer";
export type RealAppSnapshot = { processes: ProcessIdentity[]; consentSha256: string | null };

/** The account home, never the sandbox HOME that fixture children receive. */
export function realConsentPath(home = userInfo().homedir): string {
  return join(home, "Library/Application Support", RELEASE_IDENTIFIERS.desktop, "consent.json");
}
/** Hashes only; the consent file is never written, copied or recorded. */
export function snapshotRealApp(processes: NativeProcess[], consentPath = realConsentPath()): RealAppSnapshot {
  const running = processes.filter(item => item.executable === REAL_APP_EXECUTABLE).map(item => item.process).sort((a, b) => a.pid - b.pid);
  const consentSha256 = existsSync(consentPath) ? createHash("sha256").update(readFileSync(consentPath)).digest("hex") : null;
  return { processes: running, consentSha256 };
}
export function assertRealAppUnchanged(before: RealAppSnapshot, after: RealAppSnapshot): void {
  if (before.consentSha256 !== after.consentSha256) throw Error("The installed app's consent file changed during the fixture exercise");
  if (before.processes.length !== after.processes.length || before.processes.some((item, index) => !sameProcess(item, after.processes[index] ?? null))) {
    throw Error("The installed app's process changed during the fixture exercise");
  }
}
export function realAppNote(snapshot: RealAppSnapshot): string {
  return `Installed app: ${snapshot.processes.length} processes, consent file ${snapshot.consentSha256 ? "present" : "absent"}; both unchanged.`;
}
