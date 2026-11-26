import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { withLock } from "../core/lock";
import { CoreError } from "../core/errors";
import { readRun, startRun, stopRun, type RunSpec } from "../supervisor/run";
import type { Ctx } from "../types";
import { CORE_SECRET_ENV } from "../core-secrets";
import { resolveLoginShell } from "./login-shell";
import { hostVersionView, type HostVersionView } from "../session/protocol";
import { publish, type PublishReport } from "../link/publish";
import type { OutboxEvent } from "../link/envelope";

export interface TerminalRecord {
  id: string;
  kind: "shell" | "action";
  title: string;
  cwd: string;
  createdAt: number;
  rev: number;
  live: boolean;
  exit: number | null;
  cols: number;
  rows: number;
  attach: { ws: string };
  hostVersion?: HostVersionView;
}

interface StoredTerminal {
  id: string;
  kind: TerminalRecord["kind"];
  title: string;
  cwd: string;
  createdAt: number;
  rev: number;
  state: "starting" | "running" | "failed" | "closed";
  error?: string;
}

type ShellInput = { requestId: string; kind: "shell"; title?: string; cwd?: string };
type ActionInput = { requestId: string; kind: "action"; title: string; cwd?: string; argv: string[]; env?: Record<string, string> };
export type CreateTerminalInput = ShellInput | ActionInput;
interface Reservation { payload: string; id: string }
type Start = (spec: RunSpec) => { pid: number } | { error: string };
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const TERMINAL_ID = /^[0-9a-f-]{36}$/;
const MAX_LIVE = 16;

function root(ctx: Ctx): string { return join(ctx.pacerHome, "terminals"); }
function ensureRoot(ctx: Ctx): string {
  const path = root(ctx);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}
function directory(ctx: Ctx, id: string): string {
  if (!TERMINAL_ID.test(id)) throw new CoreError("invalid_input", "Invalid terminal ID");
  return join(root(ctx), id);
}
function writePrivate(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
}
function readStored(ctx: Ctx, id: string): StoredTerminal {
  try {
    const record = JSON.parse(readFileSync(join(directory(ctx, id), "record.json"), "utf8")) as StoredTerminal;
    if (record.id !== id || record.state === "closed") throw new Error("closed");
    return record;
  } catch {
    throw new CoreError("invalid_input", "Terminal not found");
  }
}
function readReservations(ctx: Ctx): Record<string, Reservation> {
  try { return JSON.parse(readFileSync(join(root(ctx), "requests.json"), "utf8")) as Record<string, Reservation>; }
  catch { return {}; }
}
function canonicalDirectory(path: string): string {
  if (!isAbsolute(path)) throw new CoreError("invalid_input", "Terminal folder must be absolute");
  try {
    const resolved = realpathSync(path);
    if (!statSync(resolved).isDirectory()) throw new Error("not a directory");
    return resolved;
  } catch {
    throw new CoreError("invalid_input", "Terminal folder is unavailable");
  }
}
function shellArgv(ctx: Ctx): string[] {
  return [resolveLoginShell(ctx.env), "-l"];
}
function presentation(ctx: Ctx, stored: StoredTerminal): TerminalRecord {
  const dir = directory(ctx, stored.id);
  const run = readRun(dir);
  let state: { cols?: number; rows?: number } = {};
  try { state = JSON.parse(readFileSync(join(dir, "session.state"), "utf8")); } catch { /* session may still be starting */ }
  return {
    id: stored.id, kind: stored.kind, title: stored.title, cwd: stored.cwd,
    createdAt: stored.createdAt, rev: stored.rev,
    live: stored.state === "running" && run.alive,
    exit: run.exit, cols: state.cols ?? 120, rows: state.rows ?? 40,
    attach: { ws: `/v3/terminals/${stored.id}/session` },
    hostVersion: hostVersionView(dir),
  };
}
/**
 * Durable "last published" marker for a terminal. It lives beside the record so a mutation on the
 * request thread, the liveness check in the background Worker and a restarted service all compare
 * against the same baseline. A marker is written only after its event reached the outbox, so a
 * failed publish is retried on the next check instead of silently losing the change.
 */
interface PublishedMarker { live?: boolean; exit?: number | null; rev?: number; removed?: true }
function markerPath(ctx: Ctx, id: string): string { return join(directory(ctx, id), "published.json"); }
function readMarker(ctx: Ctx, id: string): PublishedMarker | null {
  try {
    const value = JSON.parse(readFileSync(markerPath(ctx, id), "utf8"));
    if (value?.removed === true) return { removed: true };
    if (value && typeof value.live === "boolean" && (value.exit === null || typeof value.exit === "number") && typeof value.rev === "number") return { live: value.live, exit: value.exit, rev: value.rev };
    return null;
  } catch { return null; }
}
function writeMarker(ctx: Ctx, id: string, marker: PublishedMarker): void { writePrivate(markerPath(ctx, id), marker); }
function markerFor(record: TerminalRecord): PublishedMarker { return { live: record.live, exit: record.exit, rev: record.rev }; }
function terminalEvent(id: string, value?: TerminalRecord): OutboxEvent {
  return { type: "entity", data: value ? { kind: "terminal", id, value } : { kind: "terminal", id, removed: true } };
}
async function publishTerminal(ctx: Ctx, id: string, value: TerminalRecord | undefined, marker: PublishedMarker): Promise<void> {
  const report = await publish(ctx, [terminalEvent(id, value)]);
  // Publish is best effort, as for other entity kinds; a failed publish must NOT advance the marker.
  if (!report.errors.length && report.transports.includes("outbox")) writeMarker(ctx, id, marker);
}
function numberFile(path: string): number | null {
  try { const raw = readFileSync(path, "utf8").trim(); if (!raw) return null; const value = Number(raw); return Number.isFinite(value) ? value : null; }
  catch { return null; }
}
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
/**
 * The cheapest record the liveness check needs: no hostVersionView, and the synchronous `ps`
 * probe in readRun only runs for a terminal that still has a live pid. Closed, starting and
 * already-exited terminals never spawn a process.
 */
function livenessRecord(ctx: Ctx, stored: StoredTerminal): TerminalRecord {
  const dir = directory(ctx, stored.id);
  const exit = numberFile(join(dir, "exit"));
  let live = false;
  if (stored.state === "running" && exit === null) {
    const pid = numberFile(join(dir, "pid"));
    if (pid !== null && pidAlive(pid)) live = readRun(dir).alive;
  }
  let state: { cols?: number; rows?: number } = {};
  try { state = JSON.parse(readFileSync(join(dir, "session.state"), "utf8")); } catch { /* session may still be starting */ }
  return {
    id: stored.id, kind: stored.kind, title: stored.title, cwd: stored.cwd,
    createdAt: stored.createdAt, rev: stored.rev, live, exit,
    cols: state.cols ?? 120, rows: state.rows ?? 40,
    attach: { ws: `/v3/terminals/${stored.id}/session` },
  };
}
export interface TerminalLivenessChange { events: OutboxEvent[]; markers: { id: string; value: PublishedMarker }[] }
/**
 * Compare each registry terminal (and directory that has lost its record) against its on-disk
 * marker. No in-memory baseline: a fresh observer, another thread or a restart sees exactly the
 * same state, and the marker advances only after the caller publishes the returned events.
 */
export function terminalLivenessChanges(ctx: Ctx): TerminalLivenessChange {
  const events: OutboxEvent[] = [], markers: { id: string; value: PublishedMarker }[] = [];
  const base = root(ctx);
  if (!existsSync(base)) return { events, markers };
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || !TERMINAL_ID.test(entry.name)) continue;
    const id = entry.name;
    let stored: StoredTerminal | null = null;
    try { stored = readStored(ctx, id); } catch { /* closed or unreadable: no longer in the registry */ }
    const seen = readMarker(ctx, id);
    if (stored) {
      const record = livenessRecord(ctx, stored), marker = markerFor(record);
      if (!seen || seen.removed === true || seen.live !== marker.live || seen.exit !== marker.exit || seen.rev !== marker.rev) {
        events.push(terminalEvent(id, record));
        markers.push({ id, value: marker });
      }
    } else if (seen && seen.removed !== true) {
      events.push(terminalEvent(id));
      markers.push({ id, value: { removed: true } });
    }
  }
  return { events, markers };
}
export function commitTerminalMarkers(ctx: Ctx, markers: { id: string; value: PublishedMarker }[]): void {
  for (const { id, value } of markers) {
    try { writeMarker(ctx, id, value); } catch { /* a missing marker retries the event next tick */ }
  }
}
/**
 * Publish the liveness changes under the registry lock, so a rename/close cannot interleave
 * between this read and its marker commit. The pump calls this on its own short cadence so an
 * exit is pushed even when no client is polling; a first observation is not a change.
 */
export async function terminalLivenessEvents(ctx: Ctx, deps: { publish?: (ctx: Ctx, events: OutboxEvent[]) => Promise<PublishReport> } = {}): Promise<OutboxEvent[]> {
  return withLock(ctx, "terminal-registry", async () => {
    const { events, markers } = terminalLivenessChanges(ctx);
    if (!events.length) return [];
    const report = await (deps.publish ?? publish)(ctx, events);
    if (report.errors.length || !report.transports.includes("outbox")) return [];
    commitTerminalMarkers(ctx, markers);
    return events;
  });
}
function readTerminals(ctx: Ctx): TerminalRecord[] {
  if (!existsSync(root(ctx))) return [];
  return readdirSync(root(ctx), { withFileTypes: true }).filter(entry => entry.isDirectory() && TERMINAL_ID.test(entry.name)).flatMap(entry => {
    try { return [presentation(ctx, readStored(ctx, entry.name))]; } catch { return []; }
  }).sort((a, b) => a.createdAt - b.createdAt);
}

function validate(ctx: Ctx, input: CreateTerminalInput) {
  if (!ID.test(input.requestId)) throw new CoreError("invalid_input", "Invalid terminal request ID");
  const argv = input.kind === "shell" ? shellArgv(ctx) : input.argv;
  const title = (input.title ?? basename(argv[0] ?? "sh")).trim();
  if (!title || title.length > 80) throw new CoreError("invalid_input", "Terminal title must be 1–80 characters");
  const cwd = canonicalDirectory(input.cwd ?? ctx.home);
  if (!argv.length || argv.some(arg => typeof arg !== "string" || arg.includes("\0"))) throw new CoreError("invalid_input", "Invalid terminal command");
  if (input.kind === "action" && input.env && Object.keys(input.env).some(name => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) throw new CoreError("invalid_input", "Invalid terminal environment");
  return { title, cwd, argv };
}

/** The environment of a terminal's session: the service's, without any credential or task identity. */
function launchEnv(ctx: Ctx, argv: string[], extra: Record<string, string> | undefined, shell: boolean): Record<string, string | undefined> {
  const env: Record<string,string|undefined> = { ...process.env, ...ctx.env, ...extra, HOME: ctx.home, PACER_HOME: ctx.pacerHome };
  if (shell) env.SHELL = argv[0];
  for (const name of [...CORE_SECRET_ENV,"PACER_AUTH_TOKEN","PACER_WORK_GRANT","PACER_RUN_GRANT","PACER_REPORT_TOKEN","PACER_COMPLETION_NONCE","PACER_ADMISSION_LEASE","PACER_ADMISSION_TASK","PACER_ADMISSION_SESSION","PACER_ADMISSION_DIR","PACER_RUN_DIR","PACER_TRANSCRIPT_REPORT","PACER_ROLE","PACER_TASK_ID","PACER_HOST_SOCKET"]) delete env[name];
  return env;
}

/** How many registry terminals have a live session host. */
export function liveTerminalCount(ctx: Ctx): number {
  const base = root(ctx);
  if (!existsSync(base)) return 0;
  return readdirSync(base, { withFileTypes: true }).filter(entry => entry.isDirectory() && TERMINAL_ID.test(entry.name))
    .filter(entry => { try { return readRun(join(base, entry.name)).alive; } catch { return false; } }).length;
}

/** The login shell argv a new shell terminal runs, which also names its default title. */
export function terminalShellArgv(ctx: Ctx): string[] { return shellArgv(ctx); }

/**
 * Starts the session of a shell the native front door reserved under the registry lock it holds. The command and
 * folder come from Core and the reserved record, never from the caller, so this cannot launch anything but the login shell.
 */
export function startReservedShell(ctx: Ctx, id: string, deps: { start?: Start } = {}): ReturnType<Start> {
  const stored = readStored(ctx, id);
  if (stored.kind !== "shell" || stored.state !== "starting") throw new CoreError("conflict", "Terminal is not waiting to start");
  const argv = shellArgv(ctx);
  try { return (deps.start ?? startRun)({ dir: directory(ctx, id), cwd: stored.cwd, argv, env: launchEnv(ctx, argv, undefined, true), session: "interactive", terminal: true }); }
  catch (error) { return { error: String(error) }; }
}

/** Stops a registry terminal's session as closing it does; the caller holds the registry lock and records the close. */
export async function stopTerminalSession(ctx: Ctx, id: string): Promise<void> {
  await stopRun(terminalDirectory(ctx, id), { graceMs: 2000 });
}

/** Only trusted service code can supply action argv; the public API exposes shell creation alone. */
export async function createTerminal(ctx: Ctx, input: CreateTerminalInput, deps: { start?: Start } = {}): Promise<TerminalRecord> {
  const { title, cwd, argv } = validate(ctx, input);
  const payload = createHash("sha256").update(JSON.stringify({ kind: input.kind, title, cwd, argv, env: input.kind === "action" ? input.env : undefined })).digest("hex");
  let failure: string | undefined;
  const created = await withLock(ctx, "terminal-registry", async () => {
    const base = ensureRoot(ctx);
    const reservations = readReservations(ctx);
    const prior = reservations[input.requestId];
    if (prior) {
      if (prior.payload !== payload) throw new CoreError("conflict", "Terminal request ID was used with different details");
      const stored = readStored(ctx, prior.id);
      if (stored.state === "failed") throw new CoreError("conflict", "Terminal launch failed; start a new request", stored.error);
      return presentation(ctx, stored);
    }
    if (liveTerminalCount(ctx) >= MAX_LIVE) throw new CoreError("not_allowed", "Too many live terminals; close one before opening another");
    // Publish and marker share the registry lock with the Worker's liveness check, so a fresh
    // observer can never see a published record before its marker (or publish a duplicate).
    const publishCreated = async (record: StoredTerminal): Promise<TerminalRecord> => {
      const result = presentation(ctx, record);
      await publishTerminal(ctx, result.id, result, markerFor(result));
      return result;
    };
    const id = randomUUID();
    const dir = directory(ctx, id);
    mkdirSync(dir, { mode: 0o700 });
    const record: StoredTerminal = { id, kind: input.kind, title, cwd, createdAt: ctx.now, rev: 1, state: "starting" };
    writePrivate(join(dir, "record.json"), record);
    reservations[input.requestId] = { payload, id };
    writePrivate(join(base, "requests.json"), reservations);
    const env = launchEnv(ctx, argv, input.kind === "action" ? input.env : undefined, input.kind === "shell");
    let started: ReturnType<Start>;
    try { started = (deps.start ?? startRun)({ dir, cwd, argv, env, session: "interactive", terminal: true }); }
    catch (error) { started = { error: String(error) }; }
    if ("error" in started) {
      record.state = "failed";
      record.error = started.error;
      writePrivate(join(dir, "record.json"), record);
      failure = started.error;
      return publishCreated(record);
    }
    record.state = "running";
    writePrivate(join(dir, "record.json"), record);
    return publishCreated(record);
  });
  if (failure) throw new CoreError("not_allowed", "Could not start terminal", failure);
  return created;
}

export async function listTerminals(ctx: Ctx): Promise<TerminalRecord[]> {
  // A read never advances the on-disk marker; only a successful publish does.
  return readTerminals(ctx);
}
export async function getTerminal(ctx: Ctx, id: string): Promise<TerminalRecord> {
  return presentation(ctx, readStored(ctx, id));
}
export async function renameTerminal(ctx: Ctx, id: string, title: string, expectRev: number): Promise<TerminalRecord> {
  return withLock(ctx, "terminal-registry", async () => {
    const stored = readStored(ctx, id);
    const next = title.trim();
    if (!next || next.length > 80) throw new CoreError("invalid_input", "Terminal title must be 1–80 characters");
    if (stored.rev !== expectRev) throw new CoreError("conflict", "Terminal changed; refresh and try again");
    stored.title = next;
    stored.rev++;
    writePrivate(join(directory(ctx, id), "record.json"), stored);
    const renamed = presentation(ctx, stored);
    await publishTerminal(ctx, renamed.id, renamed, markerFor(renamed));
    return renamed;
  });
}
export async function closeTerminal(ctx: Ctx, id: string, expectRev: number): Promise<{ closed: true }> {
  return withLock(ctx, "terminal-registry", async () => {
    const stored = readStored(ctx, id);
    if (stored.rev !== expectRev) throw new CoreError("conflict", "Terminal changed; refresh and try again");
    await stopTerminalSession(ctx, id);
    stored.state = "closed";
    stored.rev++;
    writePrivate(join(directory(ctx, id), "record.json"), stored);
    await publishTerminal(ctx, id, undefined, { removed: true });
    return { closed: true as const };
  });
}

/** Resolve only registry-owned, nonclosed terminal directories for WebSocket attachment. */
export function terminalDirectory(ctx: Ctx, id: string): string {
  readStored(ctx, id);
  return directory(ctx, id);
}
