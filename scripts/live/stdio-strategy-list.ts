/** Fixed, read-only stdio witness. Generic D3 stdio remains refused. */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkout, healthy, pacerArgv, record, sandboxEnv, type Session } from "./core";

const yaml = "planner: codex\naccounts: {personal: {kind: codex}}\nrouting: [{default: [codex]}]\n";
const expected = [{ name: "default", active: true, summary: "Configured executors, Codex keeps 15%", description: "" }];
const input = [
  { jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: 3 } },
  { jsonrpc: "2.0", id: 2, method: "strategy.list", params: {} },
].map(value => JSON.stringify(value)).join("\n") + "\n";
const MAX_OUTPUT = 64 * 1024;
const TIMEOUT_MS = 15_000;

async function runFixed(session: Session, home: string, core: "real" | "stub", forward: boolean) {
  const env = sandboxEnv(session);
  delete env.PACER_WORK_GRANT;
  delete env.PACER_ROLE;
  delete env.PACER_FORWARD_OPS;
  env.PACER_HOME = home;
  env.PACER_NO_SELF_REPAIR = "1";
  env.PACER_CORE_ARGV = JSON.stringify(core === "stub"
    ? [process.execPath, join(checkout, "scripts/live/stdio-strategy-core.ts")]
    : [process.execPath, join(checkout, "src/cli.ts")]);
  if (forward) env.PACER_FORWARD_OPS = "strategy.list";
  const child = spawn(pacerArgv(session)[0], ["api", "--stdio"], {
    cwd: join(session.root, "repo"), env, stdio: ["pipe", "pipe", "pipe"], detached: true,
  });
  return await new Promise<{ code: number; replies: Record<string, unknown>[] }>((resolve, reject) => {
    let stdout = "", stderr = "", stdoutBytes = 0, stderrBytes = 0;
    let failure: Error | undefined;
    const fail = (message: string) => {
      if (failure) return;
      failure = Error(message);
      // The fixed Rust process and its core child share this owned process group.
      try { if (child.pid) process.kill(-child.pid, "SIGKILL"); }
      catch { child.kill("SIGKILL"); }
    };
    const timer = setTimeout(() => fail("fixed stdio probe timed out"), TIMEOUT_MS);
    child.stdout.on("data", chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT) { fail("fixed stdio probe exceeded stdout limit"); return; }
      stdout += chunk.toString();
    });
    child.stderr.on("data", chunk => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_OUTPUT) { fail("fixed stdio probe exceeded stderr limit"); return; }
      stderr += chunk.toString();
    });
    child.on("error", error => fail(`fixed stdio probe failed to launch: ${error.message}`));
    child.on("close", code => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code !== 0) return reject(Error(`fixed stdio probe exited ${code}: ${stderr.slice(0, 1000)}`));
      try {
        const replies = stdout.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
        resolve({ code, replies });
      } catch { reject(Error("fixed stdio probe returned malformed JSON")); }
    });
    child.stdin.end(input);
  });
}

function result(replies: Record<string, unknown>[]): unknown {
  const hello = replies.find(reply => reply.id === 1);
  if ((hello?.result as { protocol?: string } | undefined)?.protocol !== "3.0.0") throw Error("fixed stdio hello did not acknowledge v3");
  const operation = replies.find(reply => reply.id === 2);
  if (!operation || "error" in operation || replies.length !== 2) throw Error("fixed stdio strategy.list did not return one result");
  return operation.result;
}

/** Exercise the owned Rust binary with one fixed operation and two core paths. */
export async function exerciseStdioStrategyList(session: Session): Promise<void> {
  if (session.frontDoor !== "rust" || !await healthy(session)) throw Error("A running Rust live sandbox is required");
  const home = mkdtempSync(join(session.root, "stdio-strategy-list-"));
  try {
    writeFileSync(join(home, "strategy.yaml"), yaml, { mode: 0o600, flag: "wx" });
    for (const [label, core, forward, wanted] of [
      ["native selection", "stub", false, expected],
      ["forced core forwarding", "stub", true, { forwardedToFixedCore: true }],
      ["real core parity", "real", false, expected],
    ] as const) {
      try {
        const observed = result((await runFixed(session, home, core, forward)).replies);
        if (JSON.stringify(observed) !== JSON.stringify(wanted)) throw Error(`${label}: unexpected result ${JSON.stringify(observed)}`);
        record(session, { kind: "note", behavior: `Stdio strategy.list ${label}`, surface: "stdio", steps: "Fixed v3 hello then fixed read-only strategy.list in an owned probe home", verdict: "PASS", text: `${label} returned ${JSON.stringify(observed)}.` });
      } catch (error) {
        record(session, { kind: "note", behavior: `Stdio strategy.list ${label}`, surface: "stdio", steps: "Fixed v3 hello then fixed read-only strategy.list in an owned probe home", verdict: "FAIL", text: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
}
