// Actual TS START issuer and RemoteRunIO.start pre-`sent` oracle; disposable owned home only.
// Modes: host-config (pure parseHosts), issue (issuer only), start (issuer-rejected rows only,
// returns before `sent`), start-write-failure (one fixed admission.json-directory row).
// `runAttempt` (start mode only) seeds `run.attempt` instead of deriving it from `remoteDir`.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { parseHosts, type HostCfg } from "../../src/config/hosts";
import { issueConfiguredHostStart } from "../../src/plugins/host-start-issuer";
import { RemoteRunIO } from "../../src/remote/run-io";
import { WRAPPER_SH } from "../../src/supervisor/wrapper";
import { createTask, updateTask } from "../../src/tasks/store";
import type { Ctx } from "../../src/types";

interface Row {
  name: string;
  mode: "host-config" | "issue" | "start" | "start-write-failure";
  host?: Record<string, unknown>;
  remoteDir?: string;
  workdir?: string;
  args?: string[];
  argv?: string[];
  env?: Record<string, string>;
  stdin?: string;
  input?: string;
  inputLen?: number;
  reservation?: string | null;
  runAttempt?: number;
}
const PLACEHOLDER_NONCE = "00000000-0000-4000-8000-000000000000";
const DEFAULT_HOST = { ssh: "box-ssh", session: "recording" };
const base = process.env.PACER_HOME!;
const rows = (JSON.parse(await Bun.stdin.text()) as { rows: Row[] }).rows;

function normalizedHost(raw: Record<string, unknown>): HostCfg {
  const problems: string[] = [];
  const host = parseHosts({ box: raw }, problems).box;
  if (problems.length || !host) throw new Error(`host config rejected: ${problems.join("; ")}`);
  return host;
}
const yamlValue = (value: unknown) => JSON.stringify(value);
function seed(index: number, row: Row, host: HostCfg) {
  const home = join(base, `row-${index}`);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const hostYaml = Object.entries(row.host ?? DEFAULT_HOST).map(([k, v]) => `    ${k}: ${yamlValue(v)}\n`).join("");
  writeFileSync(join(home, "strategy.yaml"), `planner: claude-code\nproviders: {claude-code: {}}\nhosts:\n  box:\n${hostYaml}`, { mode: 0o600 });
  const ctx: Ctx = { home, pacerHome: home, now: 1_800_000_000, env: {},
    run: async () => ({ code: 127, stdout: "", stderr: "provider access is a fixture failure" }), which: () => null };
  const task = createTask(ctx, { brief: { goal: "remote start oracle", repo: home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  const fill = (s: string) => s.replaceAll("<ID>", task.id);
  const remoteDir = fill(row.remoteDir ?? "/remote/.pacer-remote/runs/<ID>/1");
  const workdir = fill(row.workdir ?? "/remote/work");
  const local = join(home, "runs", task.id, "1");
  const attempt = row.runAttempt ?? Number(/\/([^/]*)$/.exec(remoteDir)?.[1]);
  updateTask(ctx, task.id, record => {
    record.state = "running";
    record.run = { host: "box", mode: "new", remoteDir, remoteWorktree: workdir, workdir, dir: local,
      attempt: Number.isSafeInteger(attempt) ? attempt : 1, executor: "codex@box", startedAt: 1, logFile: "unused" };
  });
  if (row.reservation) {
    const dir = join(home, "desktop-updates");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const db = new Database(join(dir, "admission.sqlite"), { create: true });
    db.run("CREATE TABLE IF NOT EXISTS admission (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL)");
    db.query("INSERT INTO admission (id, state) VALUES (1, ?)").run(JSON.stringify({ schema: 1, reservation: row.reservation, leases: [] }));
    db.close();
    chmodSync(join(dir, "admission.sqlite"), 0o600);
  }
  return { ctx, home, task, fill, remoteDir, workdir, local, host };
}
function admissionState(home: string) {
  const path = join(home, "desktop-updates", "admission.sqlite");
  if (!existsSync(path)) return { dbExists: false, leases: [] as any[] };
  const db = new Database(path, { readonly: true });
  const raw = db.query("SELECT state FROM admission WHERE id=1").get() as { state: string } | null;
  db.close();
  return { dbExists: true, leases: raw ? JSON.parse(raw.state).leases as any[] : [] };
}
function report(home: string, local: string, error: string) {
  const { dbExists, leases } = admissionState(home);
  const file = join(local, "admission.json");
  let admissionJson: { kind: "absent" | "file" | "directory"; leaseFinished?: boolean } = { kind: "absent" };
  if (existsSync(file)) {
    if (lstatSync(file).isDirectory()) admissionJson = { kind: "directory", leaseFinished: leases.length === 0 };
    else {
      const lease = JSON.parse(readFileSync(file, "utf8")).lease;
      admissionJson = { kind: "file", leaseFinished: !leases.some(l => l.id === lease) };
    }
  }
  return { error, admissionJson, dbExists,
    leases: leases.map(l => ({ kind: l.blocker.kind, id: l.blocker.id, label: l.blocker.label, runDir: l.runDir ?? null, remote: l.remote ?? null })) };
}
function pipeArgs(s: ReturnType<typeof seed>, row: Row) {
  const env = Object.fromEntries(Object.entries(row.env ?? {}).map(([k, v]) => [k, s.fill(v)]));
  const argv = (row.argv ?? ["agent"]).map(s.fill);
  const launchEnv = { ...env, PACER_COMPLETION_NONCE: PLACEHOLDER_NONCE };
  const args = [s.remoteDir, s.workdir, "pipe", ...Object.entries(launchEnv).map(([k, v]) => `${k}=${v}`), "--", ...argv];
  return { env, argv, args, input: Buffer.from(`${WRAPPER_SH}__PACER_STDIN__\n${row.stdin ?? ""}`) };
}
const issues = (s: ReturnType<typeof seed>, args: string[], input: Uint8Array) => {
  try { issueConfiguredHostStart(s.ctx, "box", s.remoteDir, s.local, args, input); return true; } catch { return false; }
};

const out: unknown[] = [];
for (const [index, row] of rows.entries()) {
  if (row.mode === "host-config") {
    const host = normalizedHost(row.host ?? DEFAULT_HOST);
    out.push({ name: row.name, host, json: JSON.stringify(host) });
    continue;
  }
  const host = normalizedHost(row.host ?? DEFAULT_HOST);
  if (row.runAttempt !== undefined && (row.mode !== "start" || !Number.isSafeInteger(row.runAttempt)))
    throw new Error(`${row.name}: runAttempt is a start-mode safe integer only`);
  if (row.mode === "issue") {
    const s = seed(index, row, host);
    const args = (row.args ?? pipeArgs(s, row).args).map(s.fill);
    const input = row.input !== undefined ? Buffer.from(row.input) : row.inputLen !== undefined
      ? Buffer.concat([Buffer.from("__PACER_STDIN__\n"), Buffer.alloc(Math.max(0, row.inputLen - 16), 0x73)]).subarray(0, row.inputLen)
      : pipeArgs(s, row).input;
    out.push({ name: row.name, issuer: issues(s, args, input) });
    continue;
  }
  // Actual start stages a binary before issuance for a full constructor host (run-io.ts:72-79).
  if (host.session === "full") throw new Error(`${row.name}: full constructor host is not permitted in start modes`);
  if (row.mode === "start-write-failure") {
    if (row.host || row.env || row.argv || row.stdin || row.remoteDir || row.workdir || row.args || row.reservation)
      throw new Error(`${row.name}: start-write-failure accepts no overrides`);
    const s = seed(index, row, host);
    mkdirSync(s.local, { recursive: true, mode: 0o700 });
    const blocker = join(s.local, "admission.json");
    mkdirSync(blocker, { mode: 0o700 });
    if (!lstatSync(blocker).isDirectory() || lstatSync(blocker).isSymbolicLink()) throw new Error("admission.json directory setup failed");
    const p = pipeArgs(s, row);
    const result = await new RemoteRunIO(s.ctx, host, s.remoteDir, s.local).start(p.argv, s.workdir, p.env, row.stdin ?? "", { session: "pipe" });
    if (!("error" in result)) throw new Error(`${row.name}: write failure reached sent`);
    const r = report(s.home, s.local, result.error);
    if (r.admissionJson.kind !== "directory" || !r.admissionJson.leaseFinished) throw new Error(`${row.name}: unexpected effects ${JSON.stringify(r)}`);
    out.push({ name: row.name, ...r });
    continue;
  }
  const s = seed(index, row, host);
  const p = pipeArgs(s, row);
  if (issues(s, p.args, p.input)) { out.push({ name: row.name, skipped: "issuer-accepts" }); continue; }
  const result = await new RemoteRunIO(s.ctx, host, s.remoteDir, s.local).start(p.argv, s.workdir, p.env, row.stdin ?? "", { session: "pipe" });
  if (!("error" in result)) throw new Error(`${row.name}: issuer-rejected start returned a pid`);
  out.push({ name: row.name, ...report(s.home, s.local, result.error) });
}
console.log(JSON.stringify(out));
