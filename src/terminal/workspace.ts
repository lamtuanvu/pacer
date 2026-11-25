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
import { publish } from "../link/publish";
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
/** Last published state of each registry terminal, per service home. Only the service observes exits. */
const terminalSeen = new Map<string, { live: boolean; exit: number | null; rev: number }>();
function seenKey(ctx: Ctx, id: string): string { return `${ctx.pacerHome}\0${id}`; }
function terminalEvent(id: string, value?: TerminalRecord): OutboxEvent {
  return { type: "entity", data: value ? { kind: "terminal", id, value } : { kind: "terminal", id, removed: true } };
}
function remember(ctx: Ctx, record: TerminalRecord): void {
  terminalSeen.set(seenKey(ctx, record.id), { live: record.live, exit: record.exit, rev: record.rev });
}
function forget(ctx: Ctx, id: string): void {
  for (const key of terminalSeen.keys()) if (key.startsWith(`${ctx.pacerHome}\0`) && key.slice(ctx.pacerHome.length + 1) === id) terminalSeen.delete(key);
}
async function publishTerminal(ctx: Ctx, id: string, value?: TerminalRecord): Promise<void> {
  const report = await publish(ctx, [terminalEvent(id, value)]);
  if (report.errors.length) { /* publish is best effort, as for other entity kinds */ }
}
/** Test-only: drop remembered state so a fresh observer does not suppress events for existing terminals. */
export function resetTerminalObservation(home?: string): void {
  if (home === undefined) terminalSeen.clear();
  else for (const key of [...terminalSeen.keys()]) if (key.startsWith(`${home}\0`)) terminalSeen.delete(key);
}
/**
 * Compare the current registry against what was last published and return events for shells that
 * exited (or whose geometry/revision changed) and tabs that disappeared. The pump calls this so
 * an exit is pushed even when no client is polling; a first observation is not a change.
 */
export function terminalLivenessEvents(ctx: Ctx): OutboxEvent[] {
  const records = readTerminals(ctx);
  const events: OutboxEvent[] = [];
  const present = new Set<string>();
  for (const record of records) {
    present.add(record.id);
    const key = seenKey(ctx, record.id), seen = terminalSeen.get(key);
    if (seen && (seen.live !== record.live || seen.exit !== record.exit || seen.rev !== record.rev)) events.push(terminalEvent(record.id, record));
    remember(ctx, record);
  }
  for (const key of [...terminalSeen.keys()]) {
    if (!key.startsWith(`${ctx.pacerHome}\0`)) continue;
    const id = key.slice(ctx.pacerHome.length + 1);
    if (!present.has(id)) { events.push(terminalEvent(id)); terminalSeen.delete(key); }
  }
  return events;
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
  let changed = false, failure: string | undefined;
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
      changed = true; failure = started.error;
      return presentation(ctx, record);
    }
    record.state = "running";
    writePrivate(join(dir, "record.json"), record);
    changed = true;
    return presentation(ctx, record);
  });
  remember(ctx, created);
  if (changed) await publishTerminal(ctx, created.id, created);
  if (failure) throw new CoreError("not_allowed", "Could not start terminal", failure);
  return created;
}

export async function listTerminals(ctx: Ctx): Promise<TerminalRecord[]> {
  // A read must not advance the liveness baseline: a refetch between a shell exiting and
  // the pump's tick would otherwise swallow the exit event. Only the pump advances it.
  return readTerminals(ctx);
}
export async function getTerminal(ctx: Ctx, id: string): Promise<TerminalRecord> {
  return presentation(ctx, readStored(ctx, id));
}
export async function renameTerminal(ctx: Ctx, id: string, title: string, expectRev: number): Promise<TerminalRecord> {
  const renamed = await withLock(ctx, "terminal-registry", async () => {
    const stored = readStored(ctx, id);
    const next = title.trim();
    if (!next || next.length > 80) throw new CoreError("invalid_input", "Terminal title must be 1–80 characters");
    if (stored.rev !== expectRev) throw new CoreError("conflict", "Terminal changed; refresh and try again");
    stored.title = next;
    stored.rev++;
    writePrivate(join(directory(ctx, id), "record.json"), stored);
    return presentation(ctx, stored);
  });
  remember(ctx, renamed);
  await publishTerminal(ctx, renamed.id, renamed);
  return renamed;
}
export async function closeTerminal(ctx: Ctx, id: string, expectRev: number): Promise<{ closed: true }> {
  const closed = await withLock(ctx, "terminal-registry", async () => {
    const stored = readStored(ctx, id);
    if (stored.rev !== expectRev) throw new CoreError("conflict", "Terminal changed; refresh and try again");
    await stopTerminalSession(ctx, id);
    stored.state = "closed";
    stored.rev++;
    writePrivate(join(directory(ctx, id), "record.json"), stored);
    return { closed: true as const };
  });
  forget(ctx, id);
  await publishTerminal(ctx, id);
  return closed;
}

/** Resolve only registry-owned, nonclosed terminal directories for WebSocket attachment. */
export function terminalDirectory(ctx: Ctx, id: string): string {
  readStored(ctx, id);
  return directory(ctx, id);
}
