import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { withLock } from "../core/lock";
import { CoreError } from "../core/errors";
import { readRun, startRun, stopRun, type RunSpec } from "../supervisor/run";
import type { Ctx } from "../types";
import { resolveLoginShell } from "./login-shell";

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
  };
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

/** Only trusted service code can supply action argv; the public API exposes shell creation alone. */
export async function createTerminal(ctx: Ctx, input: CreateTerminalInput, deps: { start?: Start } = {}): Promise<TerminalRecord> {
  const { title, cwd, argv } = validate(ctx, input);
  const payload = createHash("sha256").update(JSON.stringify({ kind: input.kind, title, cwd, argv, env: input.kind === "action" ? input.env : undefined })).digest("hex");
  return withLock(ctx, "terminal-registry", async () => {
    const base = ensureRoot(ctx);
    const reservations = readReservations(ctx);
    const prior = reservations[input.requestId];
    if (prior) {
      if (prior.payload !== payload) throw new CoreError("conflict", "Terminal request ID was used with different details");
      const stored = readStored(ctx, prior.id);
      if (stored.state === "failed") throw new CoreError("conflict", "Terminal launch failed; start a new request", stored.error);
      return presentation(ctx, stored);
    }
    const live = readdirSync(base, { withFileTypes: true }).filter(entry => entry.isDirectory() && TERMINAL_ID.test(entry.name))
      .filter(entry => { try { return readRun(join(base, entry.name)).alive; } catch { return false; } }).length;
    if (live >= MAX_LIVE) throw new CoreError("not_allowed", "Too many live terminals; close one before opening another");
    const id = randomUUID();
    const dir = directory(ctx, id);
    mkdirSync(dir, { mode: 0o700 });
    const record: StoredTerminal = { id, kind: input.kind, title, cwd, createdAt: ctx.now, rev: 1, state: "starting" };
    writePrivate(join(dir, "record.json"), record);
    reservations[input.requestId] = { payload, id };
    writePrivate(join(base, "requests.json"), reservations);
    const env: Record<string,string|undefined> = { ...process.env, ...ctx.env, ...(input.kind === "action" ? input.env : undefined), HOME: ctx.home, PACER_HOME: ctx.pacerHome };
    if (input.kind === "shell") env.SHELL = argv[0];
    for (const name of ["PACER_AUTH_TOKEN","PACER_INTERNAL_TOKEN","PACER_WORK_GRANT","PACER_REPORT_TOKEN","PACER_COMPLETION_NONCE","PACER_ADMISSION_LEASE","PACER_ADMISSION_TASK","PACER_ADMISSION_SESSION","PACER_ADMISSION_DIR","PACER_RUN_DIR","PACER_TRANSCRIPT_REPORT","PACER_ROLE","PACER_TASK_ID"]) delete env[name];
    let started: ReturnType<Start>;
    try { started = (deps.start ?? startRun)({ dir, cwd, argv, env, session: "interactive" }); }
    catch (error) { started = { error: String(error) }; }
    if ("error" in started) {
      record.state = "failed";
      record.error = started.error;
      writePrivate(join(dir, "record.json"), record);
      throw new CoreError("not_allowed", "Could not start terminal", started.error);
    }
    record.state = "running";
    writePrivate(join(dir, "record.json"), record);
    return presentation(ctx, record);
  });
}

export async function listTerminals(ctx: Ctx): Promise<TerminalRecord[]> {
  if (!existsSync(root(ctx))) return [];
  return readdirSync(root(ctx), { withFileTypes: true }).filter(entry => entry.isDirectory() && TERMINAL_ID.test(entry.name)).flatMap(entry => {
    try { return [presentation(ctx, readStored(ctx, entry.name))]; } catch { return []; }
  }).sort((a, b) => a.createdAt - b.createdAt);
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
    return presentation(ctx, stored);
  });
}
export async function closeTerminal(ctx: Ctx, id: string, expectRev: number): Promise<{ closed: true }> {
  return withLock(ctx, "terminal-registry", async () => {
    const stored = readStored(ctx, id);
    if (stored.rev !== expectRev) throw new CoreError("conflict", "Terminal changed; refresh and try again");
    await stopRun(directory(ctx, id), { graceMs: 2000 });
    stored.state = "closed";
    stored.rev++;
    writePrivate(join(directory(ctx, id), "record.json"), stored);
    return { closed: true };
  });
}

/** Resolve only registry-owned, nonclosed terminal directories for WebSocket attachment. */
export function terminalDirectory(ctx: Ctx, id: string): string {
  readStored(ctx, id);
  return directory(ctx, id);
}
