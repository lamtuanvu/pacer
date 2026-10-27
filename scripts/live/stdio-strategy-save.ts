/** Fixed strategy.save stdio witness. Generic D3 stdio remains refused. */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkout, healthy, pacerArgv, record, sandboxEnv, type Session } from "./core";

const yaml = "# Base\nplanner: codex\naccounts: {personal: {kind: codex}}\nrouting: [{default: [codex]}]\n";
const body = "planner: codex\naccounts: \n  personal: \n    kind: codex\nrouting: \n  - default: \n      - codex\n";
const params = { name: "new-plan", draft: { from: "default" }, reason: "Fixed validation" };
const MAX_OUTPUT = 64 * 1024;
const TIMEOUT_MS = 15_000;

function fixedInput(): string {
  return [
    { jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: 3 } },
    { jsonrpc: "2.0", id: 2, method: "strategy.save", params },
  ].map(value => JSON.stringify(value)).join("\n") + "\n";
}

async function runFixed(session: Session, home: string, core: "stub" | "real", forward: boolean): Promise<unknown> {
  const env = sandboxEnv(session);
  delete env.PACER_WORK_GRANT;
  delete env.PACER_ROLE;
  delete env.PACER_FORWARD_OPS;
  env.PACER_HOME = home;
  env.PACER_NO_SELF_REPAIR = "1";
  env.PACER_CORE_ARGV = JSON.stringify(core === "stub"
    ? [process.execPath, join(checkout, "scripts/live/stdio-strategy-core.ts")]
    : [process.execPath, join(checkout, "src/cli.ts")]);
  if (forward) env.PACER_FORWARD_OPS = "strategy.save";
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
    const timer = setTimeout(() => fail("fixed strategy.save stdio probe timed out"), TIMEOUT_MS);
    child.stdout.on("data", chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT) { fail("fixed strategy.save stdio probe exceeded stdout limit"); return; }
      stdout += chunk.toString();
    });
    child.stderr.on("data", chunk => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_OUTPUT) { fail("fixed strategy.save stdio probe exceeded stderr limit"); return; }
      stderr += chunk.toString();
    });
    child.on("error", error => fail(`fixed strategy.save stdio probe failed to launch: ${error.message}`));
    child.on("close", code => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code !== 0) return reject(Error(`fixed strategy.save stdio probe exited ${code}: ${stderr.slice(0, 1000)}`));
      try {
        const replies = stdout.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
        const hello = replies.find(reply => reply.id === 1);
        if ((hello?.result as { protocol?: string } | undefined)?.protocol !== "3.0.0") throw Error("v3 hello was not acknowledged");
        const reply = replies.find(row => row.id === 2);
        if (!reply || "error" in reply || replies.length !== 2) throw Error(`strategy.save returned an error: ${JSON.stringify(reply)}`);
        resolve(reply.result);
      } catch (error) { reject(error); }
    });
    child.stdin.end(fixedInput());
  });
}

function verify(home: string, observed: unknown, forwarded: boolean): void {
  const saved = join(home, "strategies/new-plan.yaml");
  if (forwarded) {
    if (JSON.stringify(observed) !== '{"forwardedToFixedCore":true}' || existsSync(saved)
      || existsSync(join(home, "state/activity.jsonl")) || existsSync(join(home, "link/outbox.jsonl"))) {
      throw Error("forced forwarding did not return the sentinel without changing state");
    }
    return;
  }
  if (JSON.stringify(observed) !== JSON.stringify({ name: "new-plan", path: saved })) throw Error("strategy.save result mismatch");
  const content = readFileSync(saved, "utf8");
  if (!/^# Configured executors, Codex keeps 15%\n# created by agent on \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z: Fixed validation\n/.test(content)
    || !content.endsWith(body)) throw Error("strategy.save YAML bytes/header mismatch");
  if ((statSync(join(home, "strategies")).mode & 0o777) !== 0o700 || (statSync(saved).mode & 0o777) !== 0o600) {
    throw Error("strategy.save private file modes mismatch");
  }
  const activity = readFileSync(join(home, "state/activity.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const outbox = readFileSync(join(home, "link/outbox.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  if (activity.length !== 1 || activity[0].text !== "Configuration changed · strategy"
    || JSON.stringify(outbox.map(row => row.envelope.type)) !== '["entity","config"]'
    || outbox[0].envelope.data.id !== activity[0].id
    || outbox[1].envelope.data.area !== "strategy") throw Error("strategy.save activity/config event mismatch");
}

/** Three fixed runs prove native selection, forced forwarding and real-core parity. */
export async function exerciseStdioStrategySave(session: Session): Promise<void> {
  if (session.frontDoor !== "rust" || !await healthy(session)) throw Error("A running Rust live sandbox is required");
  for (const [label, core, forward] of [
    ["native selection", "stub", false],
    ["forced core", "stub", true],
    ["real core parity", "real", false],
  ] as const) {
    const home = mkdtempSync(join(session.root, "stdio-strategy-save-"));
    try {
      writeFileSync(join(home, "strategy.yaml"), yaml, { mode: 0o600, flag: "wx" });
      const observed = await runFixed(session, home, core, forward);
      verify(home, observed, forward);
      record(session, { kind: "note", behavior: `Stdio strategy.save ${label}`, surface: "stdio", steps: "Fixed v3 hello and fixed strategy.save params in owned home", verdict: "PASS", text: `${label}: result, complete YAML/modes and durable events matched.` });
    } catch (error) {
      record(session, { kind: "note", behavior: `Stdio strategy.save ${label}`, surface: "stdio", steps: "Fixed v3 hello and fixed strategy.save params in owned home", verdict: "FAIL", text: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
}
