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
import { processIdentity, sameProcess, type ProcessIdentity } from "../../src/update/desktop/process-identity";

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
/** Handover lines the service wrote after `offset` (the commit signal logs one per transaction). */
export function handoverLines(pacerHome: string, offset: number): string[] {
  let text = "";
  try { text = readFileSync(serviceLog(pacerHome)).subarray(offset).toString("utf8"); } catch { return []; }
  return text.split("\n").filter(line => line.includes("pacer: desktop update handover"));
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

/** A pacer-named copy of /bin/sleep at an unregistered path: a foreign pacer process. */
export function startForeignPacer(root: string): { process: ProcessIdentity; stop: () => void } {
  const dir = join(root, "foreign-pacer");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const binary = join(dir, "pacer");
  copyFileSync("/bin/sleep", binary);
  chmodSync(binary, 0o700);
  const child = Bun.spawn([binary, "900"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const identity = processIdentity(child.pid);
  if (!identity) { child.kill(); throw Error("Foreign pacer process identity unavailable"); }
  return { process: identity, stop: () => { if (sameProcess(processIdentity(child.pid), identity)) child.kill("SIGKILL"); } };
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
