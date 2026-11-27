// API-5b parity for the workflow run grant (`prg_`): the Rust front door must accept it exactly
// where the TypeScript service does, leave verification to the core, and refuse the rest the same
// way. Both services run as real processes on twin homes with real grants, a real git remote and a
// stub `gh`.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { childEnv, fakeServiceManager } from "./child-env";
import { fakeCtx, gitRepo, realRun } from "./helpers";
import { keychainStubPath } from "./keychain-stub";
import { spawnPinned } from "./port-isolation";
import { callOp } from "../src/api/ops";
import { createTask, listTasks, updateTask } from "../src/tasks/store";
import { ensureRunBranch, integrationWorktree } from "../src/workflow/branch";
import { defaultEngineDeps, onTaskSettled, startRun } from "../src/workflow/engine";
import { issueRunGrant, revokeRunGrant } from "../src/workflow/run-grant";
import type { WorkflowDef } from "../src/workflow/schema";
import { addDefinition, getRun, insertRun, insertStep, setPublishOptIn, updateRun } from "../src/workflow/store";
import { insertTurn } from "../src/workflow/wakeups";
import type { Ctx } from "../src/types";

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const cli = resolve(import.meta.dir, "../src/cli.ts");
const core = [process.execPath, cli];

const ask = { type: "human", question: { text: "Continue?", kind: "approve_revise" } } as const;
const define = (id: string, steps: WorkflowDef["steps"], entry: string, to = "done"): WorkflowDef =>
  ({ id, version: 1, steps: { ...steps, done: { type: "end" } }, edges: [{ from: entry, to }], entry });

const publishWf = define("t/prg-publish", { hold: ask }, "hold");
const generateWf = define("t/prg-generate", {
  plan: { type: "generate", prompt: "P", limits: { step_types: ["agent", "human"], max_steps: 4 } },
}, "plan");
const chooseWf = define("t/prg-choose", { pick: { type: "choose_workflow", from: ["t/prg-child"] } }, "pick");
const childWf = define("t/prg-child", { hold: ask }, "hold");
const decideWf = define("t/prg-decide", { route: { ...ask, decision: "auto" } }, "route");
const failWf: WorkflowDef = {
  id: "t/prg-fail",
  version: 1,
  steps: { one: { type: "agent", kind: "research", prompt: "One" }, hold: ask, done: { type: "end" } },
  edges: [{ from: "one", to: "hold" }, { from: "hold", to: "done" }],
  entry: "one",
};
const graph = JSON.stringify({
  id: "t/prg-generated", version: 1, entry: "ok",
  steps: { ok: ask, done: { type: "end" } }, edges: [{ from: "ok", to: "done" }],
});

/** A stub `gh` (no pull request exists until `pr create` prints one) and executors that refuse to run. */
function installStubs(bin: string) {
  for (const name of ["claude", "codex"]) writeFileSync(join(bin, name), "#!/bin/sh\nexit 3\n", { mode: 0o755 });
  const script = join(bin, "gh");
  writeFileSync(script, `#!/bin/sh
case "$1 $2" in
  "pr list") echo "[]" ;;
  "pr create") cat >/dev/null; echo "https://example.test/pr/1" ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
`);
  chmodSync(script, 0o755);
}

type Name = "publish" | "generate" | "choose" | "decide" | "skip" | "retry" | "stopped" | "expired" | "revoked";
interface Seeded {
  ids: Record<Name, string>;
  grants: Record<Name, string>;
  failedTask: string;
}

/** Real runs, turns and grants in a home the service then opens. */
async function seed(ctx: Ctx): Promise<Seeded> {
  for (const def of [publishWf, generateWf, chooseWf, childWf, decideWf, failWf]) addDefinition(ctx, def, "source");
  const repo = gitRepo();
  const git = async (...argv: string[]) => {
    const done = await ctx.run(["git", ...argv], 30_000);
    expect(done.code, done.stderr).toBe(0);
  };
  const origin = join(ctx.home, "origin.git");
  await git("clone", "--bare", "-q", repo, origin);
  await git("-C", repo, "remote", "add", "origin", origin);

  let turns = 0;
  /** A run has one live turn; `from` and `deadline` backdate a grant. */
  const grant = (runId: string, from = ctx, deadline = ctx.now + 3600) => {
    const turnId = `turn_prg_${++turns}`;
    // A running orchestrator task keeps the service's orphan recovery away from the turn.
    const task = createTask(ctx, { brief: { goal: "orchestrate", repo }, kind: "orchestrate", requestedExecutor: null, timeoutS: 3600 });
    updateTask(ctx, task.id, t => { t.state = "running"; });
    insertTurn(ctx, { id: turnId, runId, planner: "claude-code", status: "running", startedAt: ctx.now, deadline: ctx.now + 3600, taskId: task.id });
    return { bearer: issueRunGrant(from, { runId, turnId, deadline }), turnId };
  };
  const waiting = (def: WorkflowDef) => {
    const run = insertRun(ctx, { workflow: def.id, version: 1, repo, brief: "b", stepMode: "plain" });
    insertStep(ctx, { runId: run.id, stepId: def.entry, attempt: 1, status: "waiting" });
    updateRun(ctx, run.id, run.rev, { status: "waiting" });
    return run.id;
  };

  const publish = waiting(publishWf);
  setPublishOptIn(ctx, publish, "draft");
  await ensureRunBranch(ctx, getRun(ctx, publish)!);
  const tree = await integrationWorktree(ctx, getRun(ctx, publish)!);
  writeFileSync(join(tree, "feature.txt"), "feature");
  await git("-C", tree, "add", ".");
  await git("-C", tree, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "feature");

  const decide = waiting(decideWf);
  await callOp(ctx, "run.set_auto", { id: decide, auto: true, expect_rev: getRun(ctx, decide)!.rev });

  const deps: typeof defaultEngineDeps = {
    ...defaultEngineDeps,
    delegate: async (c, input) => createTask(c, { brief: input.brief, kind: input.kind ?? null, requestedExecutor: null, timeoutS: 600 }),
  };
  const failed = async () => {
    const run = await startRun(ctx, { workflow: failWf.id, repo, brief: "b" }, () => 1, deps);
    const task = (await callOp(ctx, "run.get", { id: run.id }) as { steps: { taskId: string }[] }).steps[0]!.taskId;
    updateTask(ctx, task, t => { t.state = "failed"; });
    await onTaskSettled(ctx, task, () => 1, deps);
    return { id: run.id, task };
  };
  const skip = await failed();
  const retry = await failed();

  const ids = {
    publish, generate: waiting(generateWf), choose: waiting(chooseWf), decide,
    skip: skip.id, retry: retry.id, stopped: waiting(publishWf), expired: waiting(publishWf), revoked: waiting(publishWf),
  };
  const grants = {} as Seeded["grants"];
  for (const [name, id] of Object.entries(ids) as [Name, string][]) {
    const issued = name === "expired" ? grant(id, { ...ctx, now: ctx.now - 100 }, ctx.now - 50) : grant(id);
    if (name === "revoked") revokeRunGrant(ctx, issued.turnId);
    grants[name] = issued.bearer;
  }
  updateRun(ctx, ids.stopped, getRun(ctx, ids.stopped)!.rev, { status: "stopped" });
  return { ids, grants, failedTask: skip.task };
}

/** Detached runners for retried and delegated steps outlive the service; end this home's before it goes. */
function killRunners(ids: string[]) {
  const ps = Bun.spawnSync(["ps", "-axo", "pid=,command="]).stdout.toString();
  for (const line of ps.split("\n")) {
    const [pid, ...command] = line.trim().split(/\s+/);
    if (pid && ids.some(id => command.join(" ").endsWith(`_run ${id}`))) try { process.kill(Number(pid), "SIGKILL"); } catch { /* Already gone. */ }
  }
}

interface Reply { label: string; status: number; type: string | null; body: string }

async function exercise(binary: string[], label: string, root: string) {
  const home = join(root, label);
  const bin = fakeServiceManager(home);
  installStubs(bin);
  mkdirSync(join(home, ".pacer"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".pacer/strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n");
  const base = childEnv(home);
  const env = {
    ...base,
    PATH: `${bin}:${keychainStubPath(home)}`,
    TZ: "Asia/Ho_Chi_Minh",
    PACER_NO_UPDATE_CHECK: "1",
    PACER_NO_SELF_REPAIR: "1",
    PACER_DISCOVERY: "off",
    PACER_DEBUG_NATIVE: "1",
    ...(binary === core ? {} : { PACER_CORE_ARGV: JSON.stringify(core) }),
  };
  const url = `http://127.0.0.1:${env.PACER_PORT}`;
  // Seeded before the service starts, so no seed write races its workflow tick.
  const ctx = fakeCtx({ home, pacerHome: env.PACER_HOME, now: Date.now() / 1000, run: realRun, env });
  const { ids, grants, failedTask } = await seed(ctx);
  const child = spawnPinned([...binary, "serve", "--port", env.PACER_PORT], { env, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const stderr = new Response(child.stderr).text();
  try {
    let up = false;
    for (let n = 0; n < 1000 && !up; n++) {
      try {
        const token = readFileSync(join(env.PACER_HOME, "token"), "utf8").trim();
        const response = await fetch(`${url}/v3/hello`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000) });
        await response.arrayBuffer();
        up = response.ok;
      } catch {}
      if (!up) await Bun.sleep(20);
    }
    if (!up) throw new Error(`${label} service did not start`);
    // The first workflow ticks replay the seeded changes; requests start once they have run.
    const ticked = () => { try { return !!JSON.parse(readFileSync(join(env.PACER_HOME, "state/background-worker.json"), "utf8")).loops?.workflow; } catch { return false; } };
    for (let n = 0; n < 1500 && !ticked(); n++) await Bun.sleep(20);
    expect(ticked(), `${label} workflow tick`).toBe(true);
    await Bun.sleep(1500);
    const replies: Reply[] = [];
    const send = async (name: string, bearer: string, path: string, body: unknown = {}, method = "POST") => {
      for (let attempt = 0; ; attempt++) {
        const response = await fetch(url + path, {
          method, headers: { authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(30_000),
          ...(method === "POST" || method === "PUT" ? { body: JSON.stringify(body) } : {}),
        });
        const reply = { label: name, status: response.status, type: response.headers.get("content-type"), body: await response.text() };
        // The core's own workflow tick can win the SQLite writer lock in either service.
        if (reply.status === 500 && reply.body.includes("database is locked") && attempt < 5) {
          await Bun.sleep(100);
          continue;
        }
        replies.push(reply);
        return reply;
      }
    };
    const op = (name: string, bearer: string, opName: string, params: unknown) => send(name, bearer, `/v3/ops/${opName}`, params);
    const rev = (id: string) => getRun(ctx, id)!.rev;

    // Credentials that no longer, or never did, answer.
    const unknown = `prg_${"0".repeat(64)}`;
    for (const [name, bearer] of Object.entries({
      unknown, expired: grants.expired, revoked: grants.revoked, stopped: grants.stopped,
      short: unknown.slice(0, -1), uppercase: `prg_${"A".repeat(64)}`,
    })) {
      const target = ids[name as Name] ?? ids.publish;
      await op(`${name} run.get`, bearer, "run.get", { id: target });
      await op(`${name} run.publish`, bearer, "run.publish", { id: target, draft: true, title: "t", body: "b", expect_rev: 1 });
    }

    // A live grant: other methods and paths stay closed.
    for (const method of ["GET", "PUT", "DELETE"]) await send(`${method} ops`, grants.publish, "/v3/ops/run.get", {}, method);
    for (const path of [
      "/v3/snapshot", "/v3/hello", "/v3/session/exchange", "/v2/ops/run.get", "/v3/ops", "/v3/ops/",
      "/v3/tasks/t-1/log", "/app/x", "/other",
    ]) await send(`POST ${path}`, grants.publish, path, { id: ids.publish });
    for (const path of ["/v3/snapshot", "/v3/events"]) await send(`GET ${path}`, grants.publish, path, undefined, "GET");
    await send("GET task log follow", grants.publish, `/v3/tasks/${failedTask}/log?follow=1`, undefined, "GET");

    // Operations outside API-5b, native and forwarded alike.
    for (const name of [
      "version.get", "task.list", "task.get", "task.delegate", "task.retry", "dispatch.child", "dispatch.review",
      "run.answer", "run.start", "run.stop", "run.set_auto", "run.cleanup", "config.set", "session.exchange",
      "assistant.tool", "dispatch.enforcement.denied", "step.nope", "nonexistent.operation",
    ]) await op(`outside ${name}`, grants.publish, name, { id: ids.publish });

    // Wrong run: a grant answers only for its own.
    for (const [name, params] of [
      ["run.get", { id: ids.generate }],
      ["run.publish", { id: ids.generate, draft: true, title: "t", body: "b", expect_rev: 1 }],
      ["run.sync_base", { id: ids.generate, expect_rev: 1 }],
      ["run.submit_graph", { id: ids.generate, step: "plan", source: graph }],
      ["run.choose", { id: ids.choose, step: "pick", workflow: childWf.id, reason: "no" }],
      ["run.decide", { id: ids.decide, step: "route", choice: "approve", reason: "no" }],
      ["step.skip", { id: ids.skip, step: "one" }],
      ["step.retry", { id: ids.retry, step: "one" }],
      ["task.stop", { id: failedTask }],
      ["task.review", { id: failedTask, verdict: "accept" }],
    ] as const) await op(`foreign ${name}`, grants.publish, name, params);
    await op("send_back", grants.skip, "task.review", { id: failedTask, verdict: "send_back" });

    // Each permitted operation, on the grant's own run.
    const own = [
      await op("own run.get", grants.publish, "run.get", { id: ids.publish }),
      await op("own run.publish", grants.publish, "run.publish", { id: ids.publish, draft: true, title: "t", body: "b", expect_rev: rev(ids.publish) }),
      await op("own run.submit_graph", grants.generate, "run.submit_graph", { id: ids.generate, step: "plan", source: graph }),
      await op("own run.choose", grants.choose, "run.choose", { id: ids.choose, step: "pick", workflow: childWf.id, reason: "fits" }),
      await op("own run.decide", grants.decide, "run.decide", { id: ids.decide, step: "route", choice: "approve", reason: "ok" }),
      await op("own step.skip", grants.skip, "step.skip", { id: ids.skip, step: "one" }),
      await op("own step.retry", grants.retry, "step.retry", { id: ids.retry, step: "one" }),
    ];

    // The orchestrator's CLI, through this binary: the path that answered 401.
    const body = join(home, "body.md");
    writeFileSync(body, "body");
    const command = Bun.spawn([...binary, "run", "publish", ids.publish, "--title", "t", "--body-file", body, "--draft"], {
      env: { ...env, PACER_ROLE: "orchestrator", PACER_RUN_GRANT: grants.publish }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000,
    });
    const [code, out, err] = await Promise.all([command.exited, new Response(command.stdout).text(), new Response(command.stderr).text()]);

    // Generated ids, clocks, hashes and paths differ between the twin homes.
    let names: [string, string][] = Object.entries(ids).map(([name, id]) => [id, `<run ${name}>`]);
    names = names.concat([[home, "<home>"], [realpathSync(home), "<home>"], [getRun(ctx, ids.publish)!.repo, "<repo>"]]);
    const normalize = (text: string) => names.reduce((value, [from, to]) => value.replaceAll(from, to), text)
      .replace(/\brun_[0-9a-z]{10}\b/g, "<run>")
      .replace(/\bt-\d{8}-\d{6}-[0-9a-f]{4}\b/g, "<task>")
      .replace(/\b(q|art)_[0-9a-z]+\b/g, "<$1>")
      .replace(/\bpacer\/run-[0-9a-z]+/g, "pacer/<branch>")
      .replace(/\b[0-9a-f]{40}\b/g, "<sha>")
      .replace(/\b1[6-9]\d{8}(\.\d+)?\b/g, "<time>");
    return {
      own: own.map(reply => ({ label: reply.label, status: reply.status })),
      replies: replies.map(reply => ({ ...reply, body: normalize(reply.body) })),
      cli: { code, out: normalize(out), err: normalize(err) },
    };
  } finally {
    child.kill("SIGTERM");
    await Promise.race([child.exited, Bun.sleep(8000)]);
    if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    killRunners(listTasks(ctx, 200).map(task => task.id));
    // No native handler ever served a request in this test's grant traffic.
    const log = await stderr;
    expect(log.split("\n").filter(line => /^native (run|step|task|question|version|config|dispatch)\./.test(line)), label).toEqual([]);
  }
}

test.skipIf(!front)("the Rust front door treats a run grant exactly as the TypeScript service does", async () => {
  // host.sock must fit SUN_LEN (~104), so the homes stay short.
  const root = realpathSync(mkdtempSync("/tmp/prg-"));
  try {
    const reference = await exercise(core, "ts", root);
    const native = await exercise([front!], "rs", root);
    expect(reference.own).toEqual(reference.own.map(reply => ({ label: reply.label, status: 200 })));
    expect(reference.cli.code, reference.cli.err).toBe(0);
    expect(native.own).toEqual(reference.own);
    expect(native.replies).toEqual(reference.replies);
    expect(native.cli).toEqual(reference.cli);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
