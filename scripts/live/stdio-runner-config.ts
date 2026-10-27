/** Fixed runner-config witnesses; generic D3 stdio remains refused. */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { checkout, healthy, pacerArgv, record, sandboxEnv, type Session } from "./core";

const MAX_OUTPUT = 64 * 1024;
const TIMEOUT_MS = 15_000;
const cases = [
  { op: "runner.reorder", params: { ids: ["cursor", "codex"] }, initial: "planner: claude-code\naccounts:\n  personal: {kind: claude}\n  codex: {kind: codex}\n  cursor: {kind: cursor}\nrouting:\n  - default: [codex, cursor]\npacing: {order: [codex, cursor], policy: priority}\n", edited: "planner: claude-code\naccounts:\n  personal: {kind: claude}\n  codex: {kind: codex}\n  cursor: {kind: cursor}\nrouting:\n  - default: [codex, cursor]\npacing: {order: [cursor, codex], policy: priority}\n", result: { order: ["cursor", "codex"] } },
  { op: "runner.set", params: { id: "codex", enabled: false }, initial: "planner: claude-code\naccounts:\n  personal: {kind: claude}\n  codex: {kind: codex}\n  cursor: {kind: cursor}\nrunners:\n  codex: {enabled: true}\nrouting:\n  - default: [codex, cursor]\npacing: {order: [codex, cursor], policy: priority}\n", edited: "planner: claude-code\naccounts:\n  personal: {kind: claude}\n  codex: {kind: codex}\n  cursor: {kind: cursor}\nrunners:\n  codex: {enabled: false}\nrouting:\n  - default: [codex, cursor]\npacing: {order: [codex, cursor], policy: priority}\n", result: { id: "codex", warnings: [] } },
] as const;
const OPENCODE = '{\n  "$schema": "https://opencode.ai/config.json",\n  "provider": {}\n}\n';

async function runFixed(session: Session, home: string, row: typeof cases[number], core: "stub" | "real", forward: boolean): Promise<unknown> {
  const env = sandboxEnv(session);
  delete env.PACER_WORK_GRANT;
  delete env.PACER_ROLE;
  delete env.PACER_FORWARD_OPS;
  env.PACER_HOME = home;
  env.PACER_NO_SELF_REPAIR = "1";
  env.PACER_CORE_ARGV = JSON.stringify(core === "stub"
    ? [process.execPath, join(checkout, "scripts/live/stdio-strategy-core.ts")]
    : [process.execPath, join(checkout, "src/cli.ts")]);
  if (forward) env.PACER_FORWARD_OPS = row.op;
  const child = spawn(pacerArgv(session)[0], ["api", "--stdio"], {
    cwd: join(session.root, "repo"), env, stdio: ["pipe", "pipe", "pipe"], detached: true,
  });
  return await new Promise<unknown>((resolve, reject) => {
    let stdout = "", stderr = "", stdoutBytes = 0, stderrBytes = 0;
    let failure: Error | undefined;
    const fail = (message: string) => {
      if (failure) return;
      failure = Error(message);
      try { if (child.pid) process.kill(-child.pid, "SIGKILL"); }
      catch { child.kill("SIGKILL"); }
    };
    const timer = setTimeout(() => fail("fixed runner stdio probe timed out"), TIMEOUT_MS);
    child.stdout.on("data", chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT) { fail("fixed runner stdio probe exceeded stdout limit"); return; }
      stdout += chunk.toString();
    });
    child.stderr.on("data", chunk => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_OUTPUT) { fail("fixed runner stdio probe exceeded stderr limit"); return; }
      stderr += chunk.toString();
    });
    child.on("error", error => fail(`fixed runner stdio probe failed to launch: ${error.message}`));
    child.on("close", code => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code !== 0) return reject(Error(`fixed runner stdio probe exited ${code}: ${stderr.slice(0, 1000)}`));
      try {
        const replies = stdout.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
        const hello = replies.find(reply => reply.id === 1);
        if ((hello?.result as { protocol?: string } | undefined)?.protocol !== "3.0.0") throw Error("v3 hello was not acknowledged");
        const reply = replies.find(item => item.id === 2);
        if (!reply || "error" in reply || replies.length !== 2) throw Error(`${row.op} returned an error: ${JSON.stringify(reply)}`);
        resolve(reply.result);
      } catch (error) { reject(error); }
    });
    child.stdin.end([
      { jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: 3 } },
      { jsonrpc: "2.0", id: 2, method: row.op, params: row.params },
    ].map(value => JSON.stringify(value)).join("\n") + "\n");
  });
}

function verify(home: string, row: typeof cases[number], observed: unknown, forwarded: boolean): void {
  const yaml = readFileSync(join(home, "strategy.yaml"), "utf8");
  if (forwarded) {
    if (JSON.stringify(observed) !== '{"forwardedToFixedCore":true}' || yaml !== row.initial
      || existsSync(join(home, "state/activity.jsonl")) || existsSync(join(home, "link/outbox.jsonl"))) {
      throw Error(`${row.op} forced forwarding changed state or missed the sentinel`);
    }
    return;
  }
  if (JSON.stringify(observed) !== JSON.stringify(row.result) || yaml !== row.edited
    || readFileSync(join(home, "opencode/opencode.json"), "utf8") !== OPENCODE) throw Error(`${row.op} result/YAML/cache mismatch`);
  if ((statSync(join(home, "strategy.yaml")).mode & 0o777) !== 0o600
    || (statSync(join(home, "opencode")).mode & 0o777) !== 0o700
    || (statSync(join(home, "opencode/opencode.json")).mode & 0o777) !== 0o600) throw Error(`${row.op} private modes mismatch`);
  const activity = readFileSync(join(home, "state/activity.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const outbox = readFileSync(join(home, "link/outbox.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  if (activity.length !== 1 || activity[0].text !== "Configuration changed · runners"
    || JSON.stringify(outbox.map(item => item.envelope.type)) !== '["entity","config"]'
    || outbox[0].envelope.data.id !== activity[0].id || outbox[1].envelope.data.area !== "runners") {
    throw Error(`${row.op} activity/config event mismatch`);
  }
}

/** Six fixed runs prove native selection, forced forwarding and real-core parity. */
export async function exerciseStdioRunnerConfig(session: Session): Promise<void> {
  if (session.frontDoor !== "rust" || !await healthy(session)) throw Error("A running Rust live sandbox is required");
  for (const row of cases) for (const [label, core, forward] of [
    ["native selection", "stub", false], ["forced core", "stub", true], ["real core parity", "real", false],
  ] as const) {
    const home = mkdtempSync(join(session.root, "stdio-runner-config-"));
    try {
      writeFileSync(join(home, "strategy.yaml"), row.initial, { mode: 0o600, flag: "wx" });
      const observed = await runFixed(session, home, row, core, forward);
      verify(home, row, observed, forward);
      record(session, { kind: "note", behavior: `Stdio ${row.op} ${label}`, surface: "stdio", steps: `Fixed v3 hello and ${row.op} parameters in owned home`, verdict: "PASS", text: `${label}: result, YAML/cache bytes/modes and durable events matched.` });
    } catch (error) {
      record(session, { kind: "note", behavior: `Stdio ${row.op} ${label}`, surface: "stdio", steps: `Fixed v3 hello and ${row.op} parameters in owned home`, verdict: "FAIL", text: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
}
