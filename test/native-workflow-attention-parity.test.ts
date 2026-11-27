// Workflow-run attention on the Rust front door: while a run is live,
// `snapshot.get` and dismiss/snooze of its items answer as forwarded TypeScript
// does, over stdio and HTTP; questions keep their native path.
import { expect, test } from "bun:test";
import { cpSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { childEnv, closedPort, fakeServiceManager } from "./child-env";
import { fakeCtx, tmpDir } from "./helpers";
import { spawnPinned } from "./port-isolation";
import { startRun, type EngineDeps } from "../src/workflow/engine";
import { deriveWorkflowAttention } from "../src/workflow/attention";
import { addDefinition, getRun, updateRun } from "../src/workflow/store";
import type { WorkflowDef } from "../src/workflow/schema";
import { REVIEW_GATE_STAYS } from "../src/view-model/run-gate";
import type { Ctx } from "../src/types";

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);
const ALL = "snapshot.get,attention.snooze,attention.dismiss";
const WORKFLOW = /^(question:q_|run_review:|budget_|orchestrator_failed:|step_failed:|unresolved_wake:)/;

/** Three live runs, each with a person question; one planner is blocked, one has spent its planning budget. */
async function fixture(): Promise<{ ctx: Ctx; ids: string[]; runs: string[] }> {
  const ctx = fakeCtx({ now: Math.floor(Date.now() / 1000) - 60, which: () => null });
  mkdirSync(join(ctx.pacerHome, "state"), { recursive: true, mode: 0o700 });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  codex: {}\n");
  const def: WorkflowDef = {
    id: "n/ask", version: 1, entry: "sign",
    steps: { sign: { type: "human", question: { text: "Sign?", kind: "approve_revise" } }, done: { type: "end" } },
    edges: [{ from: "sign", to: "done" }],
  };
  addDefinition(ctx, def, JSON.stringify(def), { prompts: {} });
  const deps: EngineDeps = { delegate: async () => { throw new Error("no agent step"); }, stopTask: () => {} };
  const runs: string[] = [];
  for (let i = 0; i < 3; i++) runs.push((await startRun(ctx, { workflow: def.id, repo: ctx.home, brief: "b" }, undefined, deps)).id);
  updateRun(ctx, runs[1]!, getRun(ctx, runs[1]!)!.rev, { orchestratorState: "blocked", reason: "three failures" });
  updateRun(ctx, runs[2]!, getRun(ctx, runs[2]!)!.rev, { spent: JSON.stringify({ orchestrator_turns: 9999, message_turns: 0 }) });
  const derived = deriveWorkflowAttention(ctx).map(item => item.id);
  const pick = (prefix: string) => {
    const id = derived.find(candidate => candidate.startsWith(prefix));
    if (!id) throw new Error(`fixture raises no ${prefix} item: ${derived}`);
    return id;
  };
  const questions = derived.filter(id => id.startsWith("question:q_"));
  if (questions.length !== runs.length) throw new Error(`fixture raises ${questions.length} questions: ${derived}`);
  return { ctx, ids: [pick("orchestrator_failed:"), pick("budget_spent:"), ...questions], runs };
}

function twin(ctx: Ctx) {
  const home = tmpDir();
  cpSync(ctx.home, home, { recursive: true });
  return home;
}

function env(home: string, forward: string, port?: number) {
  return {
    ...childEnv(home, port),
    PATH: `${join(process.env.HOME!, "bin")}:${fakeServiceManager(home)}:/usr/bin:/bin`,
    PACER_CORE_ARGV: core, PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off",
    PACER_DEBUG_NATIVE: "1", PACER_LOGIN_ENV: "off",
    ...(forward ? { PACER_FORWARD_OPS: forward } : {}),
  };
}

type Call = { method: string; params: Record<string, unknown> };
const unknown = "run_review:t-missing";
const calls = (ids: string[]): Call[] => [
  { method: "snapshot.get", params: {} },
  ...[...ids, unknown].map(id => ({ method: "attention.snooze", params: { id, for: "1h" } })),
  { method: "snapshot.get", params: {} },
  ...[...ids, unknown].map(id => ({ method: "attention.dismiss", params: { id } })),
  { method: "snapshot.get", params: {} },
];

/** What the twin homes must agree on; clocks differ between the two runs. */
function outcome(method: string, reply: { result?: any; error?: any }) {
  if (method !== "snapshot.get") {
    return { method, error: reply.error?.message, done: reply.result?.dismissed ?? typeof reply.result?.until };
  }
  const items = (reply.result?.snapshot?.attention ?? []).filter((item: { id: string }) => WORKFLOW.test(item.id));
  return {
    method, error: reply.error?.message,
    items: items.map((item: any) => ({ id: item.id, kind: item.kind, title: item.title, severity: item.severity, actions: item.actions }))
      .sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id)),
  };
}

function hidden(home: string) {
  const store = JSON.parse(readFileSync(join(home, ".pacer", "state", "attention.json"), "utf8")) as Record<string, any>;
  return Object.fromEntries(Object.entries(store).filter(([id]) => WORKFLOW.test(id)).sort(([a], [b]) => a.localeCompare(b))
    .map(([id, entry]) => [id, { snoozed: entry.snoozedUntil !== undefined, dismissed: entry.dismissedSince !== undefined && entry.dismissedSince === entry.since }]));
}

/** Ops the front door answered itself, as `<op> <request number>` or `<op>`. */
const nativeOps = (stderr: string) => stderr.split("\n").filter(line => /^native (snapshot\.get|attention\.)/.test(line)).map(line => line.slice("native ".length));

async function stdio(home: string, forward: string, requests: Call[]) {
  const child = spawnPinned([front!, "api", "--stdio"], { env: env(home, forward), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  let buffered = "";
  // Lockstep: a forwarded write must land before the next native read.
  const exchange = async (id: number, method: string, params: unknown) => {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    child.stdin.flush();
    for (;;) {
      const at = buffered.indexOf("\n");
      if (at >= 0) {
        const line = JSON.parse(buffered.slice(0, at));
        buffered = buffered.slice(at + 1);
        if (line.id === id) return line;
        continue;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error(`stdio closed: ${await stderr}`);
      buffered += new TextDecoder().decode(value);
    }
  };
  try {
    await exchange(1, "hello", { protocol: 3 });
    const replies = [];
    for (const [i, call] of requests.entries()) replies.push(outcome(call.method, await exchange(i + 2, call.method, call.params)));
    child.stdin.end();
    await child.exited;
    return { replies, native: nativeOps(await stderr) };
  } finally {
    if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; }
  }
}

async function http(home: string, forward: string, requests: Call[]) {
  const port = closedPort();
  const child = spawnPinned([front!, "serve", "--port", String(port)], { env: env(home, forward, port), stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const stderr = new Response(child.stderr).text();
  const base = `http://127.0.0.1:${port}`;
  try {
    let token = "";
    for (let i = 0; ; i++) {
      try {
        token = readFileSync(join(home, ".pacer", "token"), "utf8").trim();
        const hello = await fetch(`${base}/v3/hello`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2000) });
        await hello.arrayBuffer();
        if (hello.ok) break;
      } catch { /* not listening yet */ }
      if (child.exitCode !== null || i > 600) throw new Error(`service did not start: ${await stderr}`);
      await Bun.sleep(100);
    }
    const replies = [];
    const post = async (call: Call) => await (await fetch(`${base}/v3/ops/${call.method}`, {
      method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(call.params), signal: AbortSignal.timeout(60_000),
    })).json() as { result?: any; error?: any };
    for (const call of requests) {
      let reply = await post(call);
      // The running service writes the store; the core asks callers to retry a lost read race.
      for (let i = 0; i < 10 && reply.error?.message.startsWith("Session reservations changed"); i++) {
        await Bun.sleep(200);
        reply = await post(call);
      }
      replies.push(outcome(call.method, reply));
    }
    child.kill("SIGTERM");
    await child.exited;
    return { replies, native: nativeOps(await stderr) };
  } finally {
    if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
  }
}

for (const [transport, run] of [["stdio", stdio], ["HTTP", http]] as const) {
  test.skipIf(!front)(`workflow snapshot, snooze and dismiss match forced forwarding over ${transport}`, async () => {
    const { ctx, ids } = await fixture();
    const nativeHome = twin(ctx), forwardHome = twin(ctx);
    const requests = calls(ids);
    const native = await run(nativeHome, "", requests);
    const forwarded = await run(forwardHome, ALL, requests);
    expect(forwarded.native).toEqual([]);
    expect(native.replies).toEqual(forwarded.replies);
    // The items are listed, then hidden by the snooze, and stay hidden.
    const snapshots = native.replies.filter(reply => reply.method === "snapshot.get") as { items: { id: string }[] }[];
    expect(snapshots.map(s => s.items.map(item => item.id))).toEqual([[...ids].sort(), [], []]);
    expect(native.replies.filter(reply => reply.method !== "snapshot.get").map(reply => reply.error)).toEqual(
      // An unknown review gate is refused as a gate, before the item is looked up.
      ["snooze", "dismiss"].flatMap(() => [...ids.map(() => undefined), REVIEW_GATE_STAYS]),
    );
    expect(hidden(nativeHome)).toEqual(hidden(forwardHome));
    expect(hidden(nativeHome)).toEqual(Object.fromEntries([...ids].sort().map(id => [id, { snoozed: true, dismissed: true }])));
    // Only question snoozes stay native (their dismiss is a task-item kind, forwarded already).
    expect(native.native.map(line => line.split(" ")[0])).toEqual(["attention.snooze", "attention.snooze", "attention.snooze"]);
  }, 180_000);
}

test.skipIf(!front)("snapshot.get is native again once no workflow run is live", async () => {
  const { ctx, runs } = await fixture();
  for (const id of runs) updateRun(ctx, id, getRun(ctx, id)!.rev, { status: "stopped" });
  const home = twin(ctx);
  const { replies, native } = await stdio(home, "", [{ method: "snapshot.get", params: {} }]);
  expect(replies).toEqual([{ method: "snapshot.get", error: undefined, items: [] }]);
  expect(native).toEqual(["snapshot.get 2"]);
}, 120_000);
