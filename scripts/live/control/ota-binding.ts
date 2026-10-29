/** Scripts-only, fixed OTA-to-control observation. Never persists process ownership. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeCtx } from "../../../src/ctx";
import { readNativeTransaction } from "../../../src/update/desktop/native-record";
import { enumerateNativeProcesses } from "../../../src/update/desktop/native-os";
import { loadSession, type Session } from "../core";
import { appDigest, readOtaRecord } from "../ota";
import { withOtaLedgerLock } from "../ota-lock";
import { fixtureEnvironment, fixtureInstallation, inspectFixtureJobs, verifyFixtureBundle } from "../ota-native";
import { ControlError } from "./contract";
import { processIdentity, sameProcess } from "./lease";
import type { OperationContext } from "./deadline";
import { assertSameControlBinding, proveOtaControlBinding, type DesktopControlBinding } from "./ota-binding-proof";
export { assertSameControlBinding } from "./ota-binding-proof";

function unavailable(): never { throw new ControlError("target_unavailable", "completed OTA desktop identity could not be established"); }
function snapshot(session: Session) {
  return withOtaLedgerLock(join(session.root, "ota"), () => {
    const current = loadSession(session.id, dirname(session.root));
    if (current.stopped || current.root !== session.root || current.port !== session.port ||
        current.innerPort !== session.innerPort || current.proxyPid !== session.proxyPid || current.desktopPid || current.desktopIdentity) unavailable();
    const state = readOtaRecord(session.id, { base: dirname(session.root) });
    if (state.phase !== "prepared" || !state.nativeFixture || state.runtime?.state !== "managed" || state.runtime.request !== null ||
        state.exercise?.scenario !== "upgrade" || state.exercise.state !== "complete" || !state.exercise.transactionId) unavailable();
    if (appDigest(state.currentApp) !== state.sources[1].sha256) unavailable();
    const ctx = makeCtx({ home: state.pacerHome, pacerHome: state.pacerHome, env: fixtureEnvironment(state) });
    const transaction = readNativeTransaction(ctx, state.exercise.installationId, state.exercise.transactionId);
    if (transaction.record.phase !== "complete" || transaction.journal.state !== "committed" || !transaction.authorization) unavailable();
    return { state, transaction };
  });
}
function executableHash(path: string): string {
  if (realpathSync(path) !== path) unavailable();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid?.() || info.size <= 0 || info.size > 256 * 1024 * 1024) unavailable();
    const hash = createHash("sha256"), buffer = Buffer.alloc(65536);
    let total = 0;
    for (;;) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, info.size - total + 1), null);
      if (!count) break;
      total += count; if (total > info.size) unavailable();
      hash.update(buffer.subarray(0, count));
    }
    const after = fstatSync(fd);
    if (total !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) unavailable();
    return hash.digest("hex");
  } finally { closeSync(fd); }
}
async function boundedJson(response: Response): Promise<any> {
  const reader = response.body?.getReader();
  if (!response.ok || !reader) unavailable();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.length; if (size > 256 * 1024) unavailable();
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel(); }
}
async function serviceObservations(session: Session, servicePid: number, clock?: OperationContext) {
  const origin = `http://127.0.0.1:${session.port}`;
  const signal = () => clock?.signal ?? AbortSignal.timeout(5000);
  for (const [port, path, header, pid] of [
    [session.port, "/__live/health", "x-pacer-live-proxy", session.proxyPid],
    [session.port, "/health", "x-pacer", servicePid],
    [session.innerPort, "/health", "x-pacer", servicePid],
  ] as const) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: signal(), redirect: "error" });
    if (response.headers.get(header) !== "1" || (await boundedJson(response)).pid !== pid) unavailable();
  }
  // Only this sandbox's service token, not tool/native credentials.
  const tokenPath = join(session.root, "home/token");
  const fd = openSync(tokenPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let token: string;
  try {
    const stat = fstatSync(fd);
    if (realpathSync(tokenPath) !== tokenPath || !stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.size > 256) unavailable();
    const buffer = Buffer.alloc(257), count = readSync(fd, buffer, 0, buffer.length, null);
    if (count !== stat.size || count > 256) unavailable();
    token = buffer.subarray(0, count).toString("utf8").trim(); if (!/^[a-zA-Z0-9_-]{16,256}$/.test(token)) unavailable();
  } finally { closeSync(fd); }
  const op = async (name: "desktop.capture.targets" | "client.list") => {
    clock?.check();
    const response = await fetch(`${origin}/v3/ops/${name}`, { method: "POST", redirect: "error", signal: signal(),
      headers: { Authorization: `Bearer ${token}`, Origin: origin, "X-Pacer-Client": "app", "Content-Type": "application/json" }, body: "{}" });
    return (await boundedJson(response)).result;
  };
  return { captures: await op("desktop.capture.targets"), clients: await op("client.list") };
}
/** Every invocation is a fresh observation; no OTA authority cache or session writes. */
export async function resolveDesktopControlBinding(session: Session, clock?: OperationContext): Promise<DesktopControlBinding> {
  clock?.check();
  if (session.desktopPid || session.desktopIdentity) {
    if (!session.desktopIdentity || session.desktopPid !== session.desktopIdentity.pid) unavailable();
    if (!await sameProcess(session.desktopIdentity)) throw new ControlError("stale_reference", "owned desktop process exited or restarted", "not_delivered");
    return { source: "ordinary", identity: { ...session.desktopIdentity }, appSha256: session.desktopSha256 ?? "" };
  }
  if (process.platform !== "darwin" || !session.innerPort || !session.proxyPid) unavailable();
  try {
    const before = snapshot(session), fingerprint = JSON.stringify(before), { state } = before;
    const version = state.nativeFixture!.candidateVersion;
    // Never hold ledger flock while the inspector takes the same native lock.
    await verifyFixtureBundle(state, version); clock?.check();
    const jobs = await inspectFixtureJobs(state, false); clock?.check();
    if (fixtureInstallation(state, jobs, version, "managed").id !== state.exercise!.installationId) unavailable();
    const proof = before.transaction.journal.verificationProof;
    if (!proof) unavailable();
    const observations = await serviceObservations(session, proof.service.pid, clock);
    const appSha256 = executableHash(join(state.currentApp, "Contents/MacOS/pacer"));
    const processes = enumerateNativeProcesses(), identity = await processIdentity(proof.desktop.pid);
    const binding = proveOtaControlBinding({ ...before, jobs, processes, identity, appSha256, ...observations });
    if (JSON.stringify(snapshot(session)) !== fingerprint) unavailable();
    // Detect process replacement during filesystem/network observations as well.
    const final = proveOtaControlBinding({ ...before, jobs, processes: enumerateNativeProcesses(),
      identity: await processIdentity(proof.desktop.pid), appSha256: executableHash(join(state.currentApp, "Contents/MacOS/pacer")), ...observations });
    assertSameControlBinding(binding, final); clock?.check();
    return final;
  } catch (error) {
    if (error instanceof ControlError) throw error;
    // No raw helper, config, request or token-bearing errors enter evidence logs.
    throw new ControlError("target_unavailable", "OTA control observation refused or changed; retain native evidence");
  }
}
