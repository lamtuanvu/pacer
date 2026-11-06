import { expect } from "bun:test";
import { readdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { taskDatabase } from "../src/tasks/store";
import { join, resolve, relative } from "node:path";
import { readModelContext } from "../src/api/read-model";
import { machineGuardState } from "../src/engine/machine";
import { activeAgentSessions, agentSessionsRevision } from "../src/session/agents-state";
import { loadStrategy } from "../src/config/strategy";
import { validateExecution } from "../src/config/execution";
import { policySummary } from "../src/plugins/policy";
import { fakeCtx } from "./helpers";
import type { Ctx } from "../src/types";
import type { Status } from "../src/engine/status";
import pkg from "../package.json";

const root = resolve(import.meta.dir, "..");
const target = globalThis.process.env.CARGO_TARGET_DIR ?? join(root, ".work", "target-read-model");
let build: Promise<void> | undefined;
export function buildRustProbe(): Promise<void> {
  return build ??= (async () => {
    const child = Bun.spawn(["cargo", "build", "-q", "--locked", "-p", "pacer-read-model", "--example", "read_model_probe"], {
      cwd: root, env: { ...globalThis.process.env, CARGO_TARGET_DIR: target }, stdout: "inherit", stderr: "inherit",
    });
    const code = await child.exited;
    if (code !== 0) throw new Error(`Rust read-model probe build failed with exit code ${code}`);
  })();
}
let process: ReturnType<typeof Bun.spawn<"pipe", "pipe", "inherit">> | undefined;
let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
let pending = "";
const cases: unknown[] = [];
const homes: string[] = [];
function capture(ctx: Ctx, input: Record<string, unknown>, expected: unknown) {
  if (globalThis.process.env.EXPORT_RUST_READ_MODEL !== "1") return;
  if (!homes.includes(ctx.pacerHome)) homes.push(ctx.pacerHome);
  const db = taskDatabase(ctx);
  const tasks = db.query<{ record: string }, []>("SELECT record FROM tasks ORDER BY created_at DESC, id DESC").all().map(r => JSON.parse(r.record));
  const tables: Record<string, unknown[]> = {};
  for (const table of ["messages", "msg_liveness", "agent_sessions"]) {
    if (db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) tables[table] = db.query(`SELECT * FROM ${table} ORDER BY rowid`).all();
  }
  const files: Record<string, string> = {};
  function walk(path: string) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "tasks" && entry.name !== "locks") walk(child); }
      else if (/\.(json|jsonl|yaml)$/.test(entry.name)) files[relative(ctx.pacerHome, child)] = readFileSync(child, "utf8");
    }
  }
  walk(ctx.pacerHome);
  let serialized = JSON.stringify({ group: homes.indexOf(ctx.pacerHome), input, tasks, tables, files, expected });
  serialized = serialized.replaceAll(ctx.home, "$HOME").replaceAll(ctx.home.split("/").at(-1)!, "FIXTURE_HOME").replace(/local:[0-9a-f]{12}/g, "local:FIXTURE").replace(/m-\d{14}-[0-9a-f]{8}/g, "MESSAGE_ID");
  // Normalize task ids without disturbing ordering. Both the TS owner and the
  // Rust model sort tasks by updatedAt DESC and tie-break with the file
  // store's id-DESC order, so the replacement ids must PRESERVE the lexical
  // order of the originals (`a < b` <=> `norm(a) < norm(b)`). Assign
  // monotonic fixed-width normalized ids in LEXICOGRAPHIC order of the
  // originals (not the created_at-DESC capture order), then rewrite every
  // reference with a single callback-map pass so no already-normalized id is
  // rescanned (no generated-id collision). Kept-record sequence is unchanged.
  const originalIds = [...new Set(tasks.map(t => t.id))].sort();
  const normId = new Map(originalIds.map((id, i) => [id, `t-20261010-190000-${String(i + 1).padStart(4, "0")}`]));
  const esc = originalIds.map(id => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).sort((a, b) => b.length - a.length);
  if (esc.length) serialized = serialized.replace(new RegExp(esc.join("|"), "g"), m => normId.get(m)!);
  const parsed = JSON.parse(serialized);
  parsed.input.alive = [0];
  // PID normalization applies to console registrations in both inputs and wire output.
  for (const key of Object.keys(parsed.files)) parsed.files[key] = parsed.files[key].replaceAll(`"pid":${globalThis.process.pid}`, '"pid":0');
  if (parsed.expected?.snapshot?.service) { parsed.expected.snapshot.service.pid = 0; parsed.expected.snapshot.service.startedAt = 0; }
  if (parsed.expected?.snapshot?.machine) { parsed.expected.snapshot.machine.os = "PLATFORM"; parsed.expected.snapshot.machine.arch = "ARCH"; }
  if (parsed.expected?.snapshot?.console) parsed.expected.snapshot.console.pid = 0;
  cases.push(parsed);
  writeFileSync(join(import.meta.dir, "fixtures/read-model/rust-cases.json"), JSON.stringify(cases, null, 2) + "\n");
}
export async function rustRequest(ctx: Ctx, request: Record<string, unknown>, expected?: unknown): Promise<unknown> {
  if (!process) {
    process = Bun.spawn([join(resolve(root, target), "debug", "examples", "read_model_probe")], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
    reader = process.stdout.getReader();
  }
  const input = { home: ctx.home, pacerHome: ctx.pacerHome, now: ctx.now, env: ctx.env, zone: globalThis.process.env.TZ ?? "Asia/Ho_Chi_Minh", alive: [globalThis.process.pid], ...request };

  if (expected !== undefined) capture(ctx, input, expected);
  process.stdin.write(JSON.stringify(input) + "\n");
  process.stdin.flush();
  while (!pending.includes("\n")) {
    const row = await reader!.read();
    if (row.done) throw Error("Rust read-model probe exited before replying");
    pending += new TextDecoder().decode(row.value);
  }
  const index = pending.indexOf("\n");
  const result = JSON.parse(pending.slice(0, index));
  pending = pending.slice(index + 1);
  return result;
}
const emptyNotifiers = () => ({ os: null, terminal: null, browser: null });

function rustProbeService(expected: unknown, protocol: 2 | 3): Record<string, unknown> {
  const fallback = { version: pkg.version, protocol: protocol === 2 ? "2.8.0" : "3.0.0", pid: 0, startedAt: 0, notifiers: emptyNotifiers(), notifier: null };
  const service = (expected as { snapshot?: { service?: Record<string, unknown> } })?.snapshot?.service;
  if (!service) return fallback;
  return { ...service, pid: 0, startedAt: 0, protocol: protocol === 2 ? "2.8.0" : service.protocol ?? "3.0.0" };
}

export async function rustSnapshot(ctx: Ctx, expected: unknown, options: { status?: (ctx: Ctx) => Promise<Status>; maxBudgetAgeS?: number; includeSessions?: boolean }, protocol: 2 | 3): Promise<unknown> {
  const { setup } = await readModelContext(ctx);
  let execution;
  try { execution = loadStrategy(ctx).execution; } catch { execution = {}; }
  let status: Status | undefined, statusError: string | undefined;
  if (options.status) try { status = await options.status(ctx); } catch (e) { statusError = (e as Error).message; }
  const sessions = options.includeSessions === false ? undefined : { revision: agentSessionsRevision(ctx), active: activeAgentSessions(ctx).map(s => ({ task_id: s.task_id, executor: s.executor })) };
  const actual = await rustRequest(ctx, { op: "snapshot", protocol, setup, policy: policySummary(ctx), machine: { os: "PLATFORM", arch: "ARCH", ...machineGuardState(validateExecution(execution)) }, service: rustProbeService(expected, protocol), desktopUpdates: [], serviceInstalled: false, status, statusError, useCache: !options.status, maxBudgetAgeS: options.maxBudgetAgeS, sessions }, expected);
  // Caller normalizes only nondeterministic home/id/platform values. Byte comparison
  // keeps key order, omitted fields, arrays and every other wire byte significant.
  return actual;
}
export async function closeRustProbe() {
 const child = process, oldReader = reader;
 process = undefined; reader = undefined; pending = "";
 if (child) {
   child.stdin.end();
   await oldReader?.cancel();
   expect(await child.exited).toBe(0);
 }
}

/** Keep fixture paths canonical: TS path probes settle asynchronously on macOS. */
export function readModelCtx(options: Partial<Ctx> = {}): Ctx {
 const ctx = fakeCtx(options), home = realpathSync(ctx.home);
 return { ...ctx, home, pacerHome: options.pacerHome ?? join(home, ".pacer") };
}
