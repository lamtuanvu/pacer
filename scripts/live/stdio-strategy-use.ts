/** Fixed strategy.use stdio witness. Generic D3 stdio remains refused. */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkout, healthy, pacerArgv, record, sandboxEnv, type Session } from "./core";

type Target = "research" | "default";
type Core = "stub" | "real";
const yaml = "planner: codex\naccounts: {personal: {kind: codex}}\nrouting: [{default: [codex]}]\n";
const MAX_OUTPUT = 64 * 1024;
const TIMEOUT_MS = 15_000;

function fixedInput(target: Target): string {
  return [
    { jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: 3 } },
    { jsonrpc: "2.0", id: 2, method: "strategy.use", params: { name: target } },
  ].map(value => JSON.stringify(value)).join("\n") + "\n";
}

async function runFixed(session: Session, home: string, target: Target, core: Core, forward: boolean): Promise<unknown> {
  const env = sandboxEnv(session);
  delete env.PACER_WORK_GRANT;
  delete env.PACER_ROLE;
  delete env.PACER_FORWARD_OPS;
  env.PACER_HOME = home;
  env.PACER_NO_SELF_REPAIR = "1";
  env.PACER_CORE_ARGV = JSON.stringify(core === "stub"
    ? [process.execPath, join(checkout, "scripts/live/stdio-strategy-core.ts")]
    : [process.execPath, join(checkout, "src/cli.ts")]);
  if (forward) env.PACER_FORWARD_OPS = "strategy.use";
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
    const timer = setTimeout(() => fail("fixed strategy.use stdio probe timed out"), TIMEOUT_MS);
    child.stdout.on("data", chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT) { fail("fixed strategy.use stdio probe exceeded stdout limit"); return; }
      stdout += chunk.toString();
    });
    child.stderr.on("data", chunk => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_OUTPUT) { fail("fixed strategy.use stdio probe exceeded stderr limit"); return; }
      stderr += chunk.toString();
    });
    child.on("error", error => fail(`fixed strategy.use stdio probe failed to launch: ${error.message}`));
    child.on("close", code => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code !== 0) return reject(Error(`fixed strategy.use stdio probe exited ${code}: ${stderr.slice(0, 1000)}`));
      try {
        const replies = stdout.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
        const hello = replies.find(reply => reply.id === 1);
        if ((hello?.result as { protocol?: string } | undefined)?.protocol !== "3.0.0") throw Error("v3 hello was not acknowledged");
        const reply = replies.find(row => row.id === 2);
        if (!reply || "error" in reply || replies.length !== 2) throw Error(`strategy.use returned an error: ${JSON.stringify(reply)}`);
        resolve(reply.result);
      } catch (error) { reject(error); }
    });
    child.stdin.end(fixedInput(target));
  });
}

function seed(home: string, initial: Target): void {
  mkdirSync(join(home, "strategies"), { mode: 0o700 });
  writeFileSync(join(home, "strategy.yaml"), yaml, { mode: 0o600, flag: "wx" });
  writeFileSync(join(home, "strategies/research.yaml"), yaml, { mode: 0o600, flag: "wx" });
  if (initial === "research") writeFileSync(join(home, "active"), "research\n", { mode: 0o600, flag: "wx" });
}

function verify(home: string, target: Target, observed: unknown, forwarded: boolean): void {
  const active = join(home, "active");
  if (forwarded) {
    if (JSON.stringify(observed) !== '{"forwardedToFixedCore":true}' || existsSync(active) || existsSync(join(home, "link/outbox.jsonl"))) {
      throw Error("forced forwarding did not return the sentinel without changing state");
    }
    return;
  }
  const expectedPath = target === "default" ? join(home, "strategy.yaml") : join(home, "strategies/research.yaml");
  if (JSON.stringify(observed) !== JSON.stringify({ name: target, path: expectedPath })) throw Error("strategy.use result mismatch");
  if (target === "research") {
    if (readFileSync(active, "utf8") !== "research\n" || (statSync(active).mode & 0o777) !== 0o600) throw Error("active file bytes/mode mismatch");
  } else if (existsSync(active)) throw Error("default activation did not remove active file");
  const activity = readFileSync(join(home, "state/activity.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const outbox = readFileSync(join(home, "link/outbox.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const latest = JSON.parse(readFileSync(join(home, "link/latest.json"), "utf8"));
  if (activity.length !== 1 || activity[0].text !== "Configuration changed · strategy") throw Error("strategy activity mismatch");
  if (JSON.stringify(outbox.map(row => row.envelope.type)) !== '["alert","entity","config"]'
    || outbox[0].envelope.data.title !== `Switched to strategy ${target}`
    || outbox[1].envelope.data.id !== activity[0].id
    || outbox[2].envelope.data.area !== "strategy"
    || latest.seq !== 3 || latest.alerts?.[0]?.key !== "strategy-switch") throw Error("strategy event order/snapshot mismatch");
}

/** Five fixed runs prove native selection, forced forwarding and real-core parity. */
export async function exerciseStdioStrategyUse(session: Session): Promise<void> {
  if (session.frontDoor !== "rust" || !await healthy(session)) throw Error("A running Rust live sandbox is required");
  for (const [label, target, initial, core, forward] of [
    ["native named", "research", "default", "stub", false],
    ["native default", "default", "research", "stub", false],
    ["forced core", "research", "default", "stub", true],
    ["real core named", "research", "default", "real", false],
    ["real core default", "default", "research", "real", false],
  ] as const) {
    const home = mkdtempSync(join(session.root, "stdio-strategy-use-"));
    try {
      seed(home, initial);
      const observed = await runFixed(session, home, target, core, forward);
      verify(home, target, observed, forward);
      record(session, { kind: "note", behavior: `Stdio strategy.use ${label}`, surface: "stdio", steps: "Fixed v3 hello and fixed strategy.use params in owned home", verdict: "PASS", text: `${label}: result, active bytes/mode and durable event sequence matched.` });
    } catch (error) {
      record(session, { kind: "note", behavior: `Stdio strategy.use ${label}`, surface: "stdio", steps: "Fixed v3 hello and fixed strategy.use params in owned home", verdict: "FAIL", text: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
}
