/** Read-only proof that a native fixture exercise left the user's installed app alone. */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { userInfo } from "node:os";
import { join, relative } from "node:path";
import { RELEASE_IDENTIFIERS } from "../../src/update/desktop/bundle-identity";
import type { NativeProcess } from "../../src/update/desktop/native-os";
import { processIdentity, sameProcess, type ProcessIdentity } from "../../src/update/desktop/process-identity";

export const REAL_APP_EXECUTABLE = "/Applications/pacer.app/Contents/MacOS/pacer";
export type RealAppSnapshot = {
  processes: ProcessIdentity[];
  otherApps: { executable: string; process: ProcessIdentity }[];
  installedAppNotRunning: boolean;
  consentSha256: string | null;
  configFiles: Record<string, string>;
  servicePlistSha256: string | null;
  servicePid: number | null;
  serviceProcess: ProcessIdentity | null;
  cliLink: { type: string; target: string | null } | null;
};
export function realConsentPath(home = userInfo().homedir): string {
  return join(home, "Library/Application Support", RELEASE_IDENTIFIERS.desktop, "consent.json");
}
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
// These are normal app presentation and choice records, not fixture invariants.
const VOLATILE_CONFIG = new Set([".window-state.json", "cli-choice.json", "takeover-acknowledged.json", "takeover-dismissed.json"]);
function configHashes(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  if (!existsSync(root)) return files;
  function walk(path: string): void {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name), stat = lstatSync(child), key = relative(root, child);
      if (VOLATILE_CONFIG.has(name)) continue;
      if (stat.isDirectory()) walk(child);
      else if (stat.isFile()) files[key] = hash(child);
      else files[key] = stat.isSymbolicLink() ? `symlink:${readlinkSync(child)}` : `other:${stat.mode}`;
    }
  }
  walk(root);
  return files;
}
function loadedServicePid(): number | null {
  const result = Bun.spawnSync(["/bin/launchctl", "print", `gui/${process.getuid?.()}/com.pacer.serve`], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) return null;
  const match = result.stdout.toString().match(/^\s*pid = (\d+)\s*$/m);
  return match ? Number(match[1]) : null;
}
export function snapshotRealApp(processes: NativeProcess[], home = userInfo().homedir, servicePid = loadedServicePid()): RealAppSnapshot {
  const installed = processes.filter(item => item.executable === REAL_APP_EXECUTABLE).map(item => item.process).sort((a, b) => a.pid - b.pid);
  const otherApps = processes.flatMap(item => item.executable && item.executable.endsWith("/pacer.app/Contents/MacOS/pacer") && item.executable !== REAL_APP_EXECUTABLE
    ? [{ executable: item.executable, process: item.process }] : [])
    .sort((a, b) => a.executable.localeCompare(b.executable) || a.process.pid - b.process.pid);
  const configRoot = join(home, "Library/Application Support", RELEASE_IDENTIFIERS.desktop);
  const servicePlist = join(home, "Library/LaunchAgents/com.pacer.serve.plist");
  const cliPath = join(home, ".local/bin/pacer");
  let cliLink: RealAppSnapshot["cliLink"] = null;
  try {
    const stat = lstatSync(cliPath);
    cliLink = { type: stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : "other", target: stat.isSymbolicLink() ? readlinkSync(cliPath) : null };
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const configFiles = configHashes(configRoot);
  return { processes: installed, otherApps, installedAppNotRunning: installed.length === 0, consentSha256: configFiles["consent.json"] ?? null,
    configFiles, servicePlistSha256: existsSync(servicePlist) ? hash(servicePlist) : null, servicePid, serviceProcess: servicePid ? processIdentity(servicePid) : null, cliLink };
}
export function assertRealAppUnchanged(before: RealAppSnapshot, after: RealAppSnapshot): void {
  if (JSON.stringify({ ...before, processes: [], otherApps: [], installedAppNotRunning: false }) !== JSON.stringify({ ...after, processes: [], otherApps: [], installedAppNotRunning: false })) throw Error("The real app's files, service or CLI link changed during the fixture exercise");
  // The operator may close the installed app independently. Record that state;
  // never try to relaunch it or attribute the exit to the fixture.
  if (after.processes.length && (before.processes.length !== after.processes.length || before.processes.some((item, index) => !sameProcess(item, after.processes[index] ?? null)))) throw Error("The installed app's process changed during the fixture exercise");
  if (before.otherApps.length !== after.otherApps.length || before.otherApps.some((item, index) => item.executable !== after.otherApps[index]?.executable || !sameProcess(item.process, after.otherApps[index]?.process ?? null))) throw Error("Another pacer app process changed during the fixture exercise");
}
export function realAppNote(snapshot: RealAppSnapshot, after = snapshot): string {
  const state = snapshot.processes.length && !after.processes.length ? "exited during exercise" : after.installedAppNotRunning ? "not running" : `${after.processes.length} processes`;
  return `Installed app: ${state}; real service PID ${after.servicePid ?? "absent"}; config files ${Object.keys(after.configFiles).length}.`;
}
