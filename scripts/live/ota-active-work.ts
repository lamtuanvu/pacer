/**
 * Running work across a managed fixture update (ADR 2026-11-25). The driver opens terminals in the
 * fixture service (each one is a session host that marks its lease a survivor), samples the admission
 * row while the update runs, and checks afterwards that the hosts kept their exact incarnation and
 * that the new service handed over exactly once on commit (never on rollback). The foreign variant
 * runs a pacer-named binary from an unregistered path, which must keep the update from installing.
 */
import { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { HttpClient } from "../../src/api/http-client";
import { enumerateNativeProcesses, type NativeProcess } from "../../src/update/desktop/native-os";
import { processIdentity, sameProcess, type ProcessIdentity } from "../../src/update/desktop/process-identity";
import { FrameType, wire } from "../../src/session/framing";
import { clientHello } from "../../src/session/protocol";

export interface SurvivorWork { terminals: { id: string; host: ProcessIdentity }[]; logOffset: number }
export interface AdmissionSample { at: string; reservation: string | null; survivors: boolean; leases: number; survivorLeases: number }

/** The admission row as the fixture service wrote it; never a write. */
export function readAdmissionRow(pacerHome: string): { reservation: string | null; survivors?: boolean; leases: { class?: string; blocker: { label: string } }[] } | null {
  const path = join(pacerHome, "desktop-updates/admission.sqlite");
  if (!existsSync(path)) return null;
  const db = new Database(path, { readonly: true });
  try {
    const row = db.query<{ state: string }, []>("SELECT state FROM admission WHERE id = 1").get();
    return row ? JSON.parse(row.state) : null;
  } finally { db.close(); }
}

export function sampleAdmission(pacerHome: string): AdmissionSample | null {
  const row = readAdmissionRow(pacerHome);
  if (!row) return null;
  return { at: new Date().toISOString(), reservation: row.reservation, survivors: row.survivors === true, leases: row.leases.length, survivorLeases: row.leases.filter(lease => lease.class === "survivor").length };
}

function serviceLog(pacerHome: string): string { return join(pacerHome, "logs/serve.log"); }
function logSize(pacerHome: string): number { try { return statSync(serviceLog(pacerHome)).size; } catch { return 0; } }
function logSince(pacerHome: string, offset: number): string[] {
  try { return readFileSync(serviceLog(pacerHome)).subarray(offset).toString("utf8").split("\n"); } catch { return []; }
}
export interface HandoverRun { origin: "commit" | "request"; signalled: number; summary: string }
/**
 * Handover runs the service logged after `offset`, one line per run (`sharedHandover`): the commit
 * signal is `commit`, the desktop's step-0 `service.handover` call is `request`. Failed runs are
 * returned separately and never count as a handover.
 */
export function handoverRuns(lines: readonly string[]): { runs: HandoverRun[]; failed: string[] } {
  const runs: HandoverRun[] = [], failed: string[] = [];
  for (const line of lines) {
    const ok = /pacer: handover \((commit|request)\): signalled=(\d+); (.*)$/.exec(line);
    if (ok) { runs.push({ origin: ok[1] as HandoverRun["origin"], signalled: Number(ok[2]), summary: ok[3]! }); continue; }
    if (/pacer: handover \((commit|request)\) failed: /.test(line)) failed.push(line);
  }
  return { runs, failed };
}
export function serviceHandoverRuns(pacerHome: string, offset: number) { return handoverRuns(logSince(pacerHome, offset)); }
/**
 * Exactly one handover per committed update: one commit run whose summary counts the surviving
 * sessions as kept running, no failed run, and any step-0 request run after it signalled nothing.
 * A rolled-back update has no run at all.
 */
export function assertOneHandover(result: ReturnType<typeof handoverRuns>, committed: boolean, sessions: number): HandoverRun | null {
  if (result.failed.length) throw Error(`A handover run failed: ${result.failed[0]!.slice(0, 300)}`);
  const commits = result.runs.filter(run => run.origin === "commit");
  if (!committed) {
    if (result.runs.length) throw Error("A rolled-back update handed over running work");
    return null;
  }
  if (commits.length !== 1) throw Error(`Expected one commit handover, found ${commits.length}`);
  const kept = /(\d+) tasks? and (\d+) sessions? kept running/.exec(commits[0]!.summary);
  if (!kept || Number(kept[2]) < sessions) throw Error(`The commit handover did not count the surviving sessions: ${commits[0]!.summary.slice(0, 300)}`);
  if (result.runs.some(run => run.origin === "request" && run.signalled > 0)) throw Error("The desktop's step-0 call signalled runners a second time");
  return commits[0]!;
}
/**
 * The refusal the service logs when coverage rejects a foreign pacer (`assertNativeProcessCoverage`),
 * with how many of the refused processes sat inside a survivor's lease tree.
 */
export function coverageRefusals(lines: readonly string[]): { foreign: number; leaseTree: number }[] {
  return lines.flatMap(line => {
    const match = /pacer: desktop update coverage refused: foreign=(\d+) lease-tree=(\d+)/.exec(line);
    return match ? [{ foreign: Number(match[1]), leaseTree: Number(match[2]) }] : [];
  });
}
/** The service layer refused because of a pacer inside a survivor's process tree (ADR point 2). */
export function leaseTreeRefusalLogged(pacerHome: string, offset: number): { foreign: number; leaseTree: number } | null {
  return coverageRefusals(logSince(pacerHome, offset)).find(refusal => refusal.leaseTree > 0) ?? null;
}

function hostOf(pacerHome: string, id: string): ProcessIdentity | null {
  try {
    const pid = Number(readFileSync(join(pacerHome, "terminals", id, "pid"), "utf8").trim());
    return Number.isSafeInteger(pid) && pid > 1 ? processIdentity(pid) : null;
  } catch { return null; }
}

/** Open terminals and wait until every host has claimed and marked its lease a survivor. */
export async function startSurvivorWork(client: HttpClient, pacerHome: string, count = 2, timeoutMs = 60000): Promise<SurvivorWork> {
  const logOffset = logSize(pacerHome);
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const record = await client.call<{ id: string }>("terminal.create", { request_id: `active-work-${randomUUID()}`, kind: "shell" });
    ids.push(record.id);
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hosts = ids.map(id => hostOf(pacerHome, id));
    const row = readAdmissionRow(pacerHome);
    const marked = row?.leases.filter(lease => lease.class === "survivor").length ?? 0;
    if (hosts.every(Boolean) && marked >= count) return { terminals: ids.map((id, n) => ({ id, host: hosts[n]! })), logOffset };
    await Bun.sleep(250);
  }
  throw Error("Terminal session hosts did not claim survivor leases");
}

/** Every host is still the exact incarnation that ran before the update. */
export function assertSurvivorsAlive(pacerHome: string, work: SurvivorWork): void {
  for (const terminal of work.terminals) {
    if (!sameProcess(processIdentity(terminal.host.pid), terminal.host)) throw Error(`Terminal ${terminal.id} host did not survive the update`);
    const now = hostOf(pacerHome, terminal.id);
    if (!now || !sameProcess(now, terminal.host)) throw Error(`Terminal ${terminal.id} host changed during the update`);
  }
}

/** A reservation held while survivor leases ran, with the admitted flag, must have been observed. */
export function assertSurvivorReservation(samples: readonly AdmissionSample[], transactionId: string): void {
  if (!samples.some(sample => sample.reservation === transactionId && sample.survivors && sample.survivorLeases > 0 && sample.survivorLeases === sample.leases)) {
    throw Error("No survivor reservation was observed for the update transaction");
  }
}

/** Type one line into a terminal through its public session socket (take control, send input, detach). */
export async function typeIntoTerminal(base: string, token: string, terminalId: string, line: string, timeoutMs = 15000): Promise<void> {
  const url = new URL(`/v3/terminals/${terminalId}/session`, base); url.protocol = "ws:";
  const Socket = globalThis.WebSocket as unknown as { new(url: string, options: Bun.WebSocketOptions): WebSocket };
  const ws = new Socket(url.href, { headers: { Authorization: `Bearer ${token}` } });
  ws.binaryType = "arraybuffer";
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Terminal session control timed out")), timeoutMs);
      ws.onerror = () => { clearTimeout(timer); reject(Error("Terminal session connection failed")); };
      ws.onmessage = event => {
        if (typeof event.data !== "string") return;
        const value = JSON.parse(event.data);
        if (value.type === "control" && value.you === true) {
          ws.send(new Uint8Array(wire(FrameType.input, Buffer.from(`${line}\n`))));
          clearTimeout(timer); resolve();
        } else if (value.type === "control" && ["refused", "read-only"].includes(value.reason)) { clearTimeout(timer); reject(Error("Terminal session control was refused")); }
      };
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "hello", v: 1, client: "cli", label: "agent", cols: 120, rows: 40, ...clientHello() }));
        ws.send(JSON.stringify({ type: "take", force: true }));
      };
    });
    await Bun.sleep(250);
  } finally { ws.close(); }
}

function descendsFrom(processes: readonly NativeProcess[], child: NativeProcess, ancestor: number): boolean {
  const byPid = new Map(processes.map(item => [item.process.pid, item]));
  let current: NativeProcess | undefined = child;
  for (let hops = 0; current && hops < 64; hops++) {
    if (current.parentPid === ancestor) return true;
    current = byPid.get(current.parentPid);
  }
  return false;
}
/**
 * A pacer-named copy of /bin/sleep at an unregistered path, started from inside a survivor
 * terminal's shell, so it is a descendant of a survivor session host (ADR 2026-11-25 point 2).
 */
export async function startForeignPacerInTerminal(root: string, base: string, token: string, work: SurvivorWork, timeoutMs = 20000): Promise<{ process: ProcessIdentity; stop: () => void }> {
  const dir = join(root, "foreign-pacer");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const binary = join(dir, "pacer");
  copyFileSync("/bin/sleep", binary);
  chmodSync(binary, 0o700);
  const terminal = work.terminals[0]!;
  await typeIntoTerminal(base, token, terminal.id, `'${binary.replaceAll("'", "'\\''")}' 900`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const processes = enumerateNativeProcesses();
    const found = processes.find(item => item.executable === binary && descendsFrom(processes, item, terminal.host.pid));
    if (found) {
      const identity = found.process;
      return { process: identity, stop: () => { if (sameProcess(processIdentity(identity.pid), identity)) process.kill(identity.pid, "SIGKILL"); } };
    }
    await Bun.sleep(250);
  }
  throw Error("The foreign pacer process did not start under the survivor terminal");
}

/** Close the terminals the scenario opened (best effort; evidence stays). */
export async function closeSurvivorWork(client: HttpClient, work: SurvivorWork | null): Promise<void> {
  if (!work) return;
  const listed = await client.call<{ terminals?: { id: string; rev: number }[] } | { id: string; rev: number }[]>("terminal.list", {}).catch(() => null);
  const rows = Array.isArray(listed) ? listed : listed?.terminals ?? [];
  for (const terminal of work.terminals) {
    const row = rows.find(item => item.id === terminal.id);
    if (row) await client.call("terminal.close", { id: terminal.id, expect_rev: row.rev }).catch(() => {});
  }
}
