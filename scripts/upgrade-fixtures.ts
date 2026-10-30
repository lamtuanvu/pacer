// scripts/upgrade-fixtures.ts
/**
 * Record session-protocol and run-directory fixtures for every release in the support window.
 * Usage: bun scripts/upgrade-fixtures.ts v0.10.0 v0.11.0 v0.12.0
 * Needs network for `bun install --frozen-lockfile` in each temporary release worktree.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const out = join(root, "test/fixtures/upgrade");
const RECORDER = String.raw`
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTask, readTask, updateTask } from "./src/tasks/store";
import { readRun, startRun } from "./src/supervisor/run";
import { superviseTask } from "./src/tasks/api";
const [out, scratch] = process.argv.slice(2);
const home = join(scratch, "home"), pacerHome = join(home, ".pacer"), repo = join(scratch, "repo");
mkdirSync(repo, { recursive: true }); mkdirSync(pacerHome, { recursive: true });
const env = { PATH: process.env.PATH };
const ctx = { home, pacerHome, now: Math.floor(Date.now() / 1000), env, run: async () => ({ code: 127, stdout: "", stderr: "" }), which: () => null } as any;
const wait = async (dir: string) => { for (let i = 0; i < 300 && readRun(dir).exit === null; i++) await Bun.sleep(50); if (readRun(dir).exit === null) throw Error("run did not exit: " + dir); };
const copyRun = (dir: string, name: string) => {
  const target = join(out, name); mkdirSync(target, { recursive: true });
  for (const file of readdirSync(dir)) if (!["session.sock", "run.sh"].includes(file) && !file.endsWith(".tmp")) cpSync(join(dir, file), join(target, file));
};
const headless = join(pacerHome, "runs", "t-20261029-000000-aaaa", "1");
startRun({ dir: headless, argv: ["sh", "-c", "echo fixture-output"], cwd: repo, env });
await wait(headless); copyRun(headless, "run-headless");
const interactive = join(pacerHome, "runs", "t-20261029-000000-bbbb", "1");
startRun({ dir: interactive, argv: ["sh", "-c", "printf 'fixture-ready\\n'; sleep 1"], cwd: repo, env, session: "interactive" });
await wait(interactive); copyRun(interactive, "run-interactive");
const task = createTask(ctx, { brief: { goal: "fixture", repo }, kind: null, requestedExecutor: "codex", timeoutS: 600 });
const running = updateTask(ctx, task.id, t => {
  t.state = "running"; t.executor = "codex"; t.runnerPid = 4194303; t.attemptStartedAt = ctx.now;
  t.run = { dir: headless, attempt: 1, executor: "codex", startedAt: ctx.now, mode: "current", workdir: repo, logFile: join(pacerHome, "tasks", task.id + ".codex.log") };
});
writeFileSync(join(out, "task-running.json"), JSON.stringify(running, null, 2) + "\n");
const live = join(pacerHome, "runs", "t-20261029-000000-cccc", "1");
startRun({ dir: live, argv: ["sh", "-c", "sleep 20"], cwd: repo, env });
const gap = createTask(ctx, { brief: { goal: "handed over", repo }, kind: null, requestedExecutor: "codex", timeoutS: 600 });
updateTask(ctx, gap.id, t => {
  t.state = "running"; t.executor = "codex"; t.attemptStartedAt = ctx.now;
  t.run = { dir: live, attempt: 1, executor: "codex", startedAt: ctx.now, mode: "current", workdir: repo, logFile: join(pacerHome, "tasks", gap.id + ".codex.log") };
  (t as any).handover = { protocol: 1, pacer: "0.13.1", identity: { pid: 4194303, bootId: "fixture", birth: "1" }, state: "handed-over", committedAt: ctx.now };
});
let spawned = 0;
const after = await superviseTask(ctx, gap.id, () => { spawned++; return 4194302; });
writeFileSync(join(out, "rollback-sweep.json"), JSON.stringify({ spawned, state: after?.state ?? null, handoverKept: !!(readTask(ctx, gap.id) as any)?.handover }, null, 2) + "\n");
process.kill(-Number(readFileSync(join(live, "pid"), "utf8")), "SIGKILL");
`;

async function sh(argv: string[], cwd: string, env: Record<string, string | undefined> = process.env): Promise<string> {
  const child = Bun.spawn(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw Error(`${argv.join(" ")} exited ${code}: ${stderr}`);
  return stdout;
}
/** Replace the recording directory (and its realpath, e.g. /private/var/… on macOS) with `$SCRATCH`. */
function scrub(dir: string, prefixes: string[]): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { scrub(path, prefixes); continue; }
    const bytes = readFileSync(path);
    if (!prefixes.some(prefix => bytes.includes(Buffer.from(prefix)))) continue;
    if (name === "session.log" || name === "session.log.1") throw Error(`binary recording ${relative(root, path)} contains the scratch path`);
    let text = bytes.toString("utf8");
    for (const prefix of prefixes) text = text.replaceAll(prefix, "$SCRATCH");
    text = text.replaceAll("$SCRATCH/home/", "$HOME/");
    writeFileSync(path, text);
  }
}

for (const tag of process.argv.slice(2)) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw Error(`expected a release tag like v0.11.0, got ${tag}`);
  const version = tag.slice(1), target = join(out, version);
  rmSync(target, { recursive: true, force: true }); mkdirSync(target, { recursive: true });
  for (const [path, name] of [["app/src/term/client.ts", "term-client.ts"], ["src/session/viewers.ts", "viewers.ts"], ["src/session/framing.ts", "framing.ts"]]) {
    const source = await sh(["git", "show", `${tag}:${path}`], root);
    const imports = [...source.matchAll(/^import .* from ['"]([^'"]+)['"]/gm)].map(m => m[1]);
    if (imports.some(spec => !["node:net", "./framing"].includes(spec))) throw Error(`${tag}:${path} has imports this fixture cannot satisfy: ${imports.join(", ")}`);
    writeFileSync(join(target, name), source);
  }
  const attach = await sh(["git", "show", `${tag}:src/session/attach.ts`], root);
  const cliHello = attach.match(/send\(wire\(FrameType\.hello,(\{v:1,client:"cli"[^\n]+?\})\)\);/);
  if (!cliHello) throw Error(`${tag} CLI hello changed; update test/upgrade-compat.test.ts`);
  writeFileSync(join(target, "cli-hello.ts"), `// Captured from ${tag}:src/session/attach.ts by scripts/upgrade-fixtures.ts.\nexport const oldCliHello = (stdout: {columns?: number; rows?: number} = {}) => (${cliHello[1]});\n`);
  const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pacer-upgrade-fixture-"));
  const tree = join(scratch, "tree");
  try {
    await sh(["git", "worktree", "add", "--detach", tree, tag], root);
    await sh(["bun", "install", "--frozen-lockfile"], tree);
    writeFileSync(join(tree, ".pacer-fixture-record.ts"), RECORDER);
    await sh([process.execPath, ".pacer-fixture-record.ts", target, join(scratch, "data")], tree, { PATH: process.env.PATH, HOME: join(scratch, "data", "home"), TZ: "UTC" });
    const data = join(scratch, "data");
    scrub(target, [...new Set([realpathSync(data), data])].sort((a, b) => b.length - a.length));
  } finally {
    await sh(["git", "worktree", "remove", "--force", tree], root).catch(() => {});
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log(`recorded ${relative(root, target)}`);
}
