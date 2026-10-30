// scripts/ci/service-survival.ts
/**
 * CI (Linux): a delegated run and a session host that the service started survive
 * `systemctl --user restart pacer-serve.service`. Without a user service manager the result is UNVERIFIED.
 */
import { appendFileSync, chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { processIdentity, sameProcess, type ProcessIdentity } from "../../src/update/desktop/process-identity";

const root = join(import.meta.dir, "..", "..");
const systemctl = process.env.PACER_SURVIVAL_SYSTEMCTL ?? "systemctl";
const unitLink = join(process.env.PACER_SURVIVAL_UNIT_DIR ?? join(process.env.HOME ?? "", ".config/systemd/user"), "pacer-serve.service");
const lstatOrNull = (path: string) => { try { return lstatSync(path); } catch { return null; } };
const note = (line: string) => { console.log(line); if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`); };
async function run(argv: string[], env: Record<string, string | undefined>) {
  try {
    const child = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, out, err };
  } catch (error) { return { code: 127, out: "", err: (error as Error).message }; }
}
async function until<T>(what: string, probe: () => T | undefined | Promise<T | undefined>, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw Error(`timed out waiting for ${what}`);
    await Bun.sleep(250);
  }
}

const probe = process.env.GITHUB_ACTIONS === "true"
  ? await run([systemctl, "--user", "show-environment"], process.env)
  : { code: 127, err: "outside GitHub Actions" };
if (process.platform !== "linux" || probe.code !== 0) {
  note(`UNVERIFIED: Linux service restart survival — no user service manager here (${probe.err.trim() || process.platform}).`);
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), "pacer-survival-"));
const userHome = join(work, "user"), pacerHome = join(work, "home"), bin = join(work, "bin"), repo = join(work, "repo");
for (const dir of [pacerHome, bin, repo, join(userHome, ".codex")]) mkdirSync(dir, { recursive: true });
copyFileSync(join(root, "dist/pacer-core"), join(bin, "pacer")); chmodSync(join(bin, "pacer"), 0o755);
symlinkSync(join(root, "test/fixtures/bin/fake-agent"), join(bin, "codex"));
// Routing checks for a login indicator; this disposable CI home holds no credentials.
writeFileSync(join(userHome, ".codex", "auth.json"), "{}");
writeFileSync(join(pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}, codex: {usage: reactive}}\nexecution: {backend: direct, launch_mode: headless}\n");
const port = 47_000 + Math.floor(Math.random() * 1000);
const env = { ...process.env, HOME: userHome, PACER_HOME: pacerHome, PACER_BIN: join(bin, "pacer"), PACER_PORT: String(port), PACER_NO_UPDATE_CHECK: "1", PATH: `${bin}:${process.env.PATH}` };
const pacer = async (...args: string[]) => { const r = await run([join(bin, "pacer"), ...args], env); if (r.code !== 0) throw Error(`pacer ${args.join(" ")} exited ${r.code}: ${r.err}${r.out}`); return r.out; };
await run(["git", "-C", repo, "init", "-q"], env);
await run(["git", "-C", repo, "-c", "user.name=CI", "-c", "user.email=ci@example.invalid", "commit", "--allow-empty", "-qm", "fixture"], env);

const health = async (): Promise<number | undefined> => {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    const body = await r.json() as { ok?: boolean; pid?: number };
    return r.headers.get("x-pacer") === "1" && body.ok && body.pid ? body.pid : undefined;
  } catch { return undefined; }
};
async function op<T>(name: string, params: unknown): Promise<T> {
  const token = readFileSync(join(pacerHome, "token"), "utf8").trim();
  const r = await fetch(`http://127.0.0.1:${port}/v3/ops/${name}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(params) });
  const body = await r.json() as { result?: T; error?: { message: string } };
  if (!r.ok) throw Error(`${name}: ${body.error?.message ?? r.status}`);
  return body.result as T;
}
const num = (path: string) => Number(readFileSync(path, "utf8").trim());

let failed = true;
let isolatedUnit = false;
try {
  const prior = await run([systemctl, "--user", "show", "pacer-serve.service", "--property=FragmentPath", "--value"], env);
  if (prior.out.trim()) throw Error(`Refusing to replace an existing user service: ${prior.out.trim()}`);
  // systemd's user manager reads units from the runner's real home, which it fixed at
  // startup; link the disposable home's unit there so pacer still writes only its own files.
  if (existsSync(unitLink) || lstatOrNull(unitLink)) throw Error(`Refusing to replace an existing user unit: ${unitLink}`);
  mkdirSync(dirname(unitLink), { recursive: true });
  symlinkSync(join(userHome, ".config/systemd/user/pacer-serve.service"), unitLink);
  isolatedUnit = true;
  await pacer("service", "install", "--replace");
  const servicePid = await until("the service to answer", health);
  const task = await op<{ task_id: string }>("task.delegate", { repo, goal: "Wait for the restart survival check", executor: "codex", source: "cli", timeout_min: 10, worktree: "current", worktree_reason: "disposable CI fixture" });
  const record = await until("the delegated run to start", () => {
    try {
      const t = JSON.parse(readFileSync(join(pacerHome, "tasks", `${task.task_id}.json`), "utf8")) as { state: string; runnerPid?: number; run?: { dir: string } };
      return t.state === "running" && t.runnerPid && t.run && existsSync(join(t.run.dir, "child")) ? t as { runnerPid: number; run: { dir: string } } : undefined;
    } catch { return undefined; }
  });
  const terminal = await op<{ id: string; rev: number }>("terminal.create", { request_id: "ci-survival", kind: "shell", cwd: repo });
  const terminalDir = join(pacerHome, "terminals", terminal.id);
  await until("the terminal host to start", () => existsSync(join(terminalDir, "child")) ? true : undefined);
  const watched: [string, ProcessIdentity | null][] = [
    ["task runner", processIdentity(record.runnerPid)],
    ["run wrapper", processIdentity(num(join(record.run.dir, "pid")))],
    ["agent", processIdentity(num(join(record.run.dir, "child")))],
    ["terminal session host", processIdentity(num(join(terminalDir, "pid")))],
    ["terminal shell", processIdentity(num(join(terminalDir, "child")))],
  ];
  for (const [name, identity] of watched) if (!identity) throw Error(`could not read the ${name}'s identity`);
  const restart = await run([systemctl, "--user", "restart", "pacer-serve.service"], env);
  if (restart.code !== 0) throw Error(`systemctl restart failed: ${restart.err}`);
  await until("the restarted service", async () => { const pid = await health(); return pid && pid !== servicePid ? pid : undefined; });
  await Bun.sleep(2000);
  failed = false;
  for (const [name, identity] of watched) {
    const alive = sameProcess(processIdentity(identity!.pid), identity);
    if (!alive) failed = true;
    note(`${alive ? "PASS" : "FAIL"}: ${name} (pid ${identity!.pid}) ${alive ? "survived" : "did not survive"} systemctl --user restart`);
  }
  await op("task.stop", { id: task.task_id }).catch(() => {});
  await op("terminal.close", { id: terminal.id, expect_rev: terminal.rev }).catch(() => {});
} finally {
  if (isolatedUnit) {
    await run([join(bin, "pacer"), "service", "uninstall", "--stop-work", "--yes"], env);
    if (lstatOrNull(unitLink)?.isSymbolicLink()) unlinkSync(unitLink);
    await run([systemctl, "--user", "daemon-reload"], env);
  }
}
process.exit(failed ? 1 : 0);
