import { expect, test } from "bun:test";
import {
  OrcaClient, type CheckResult, agentTerminalOf, isLiveTerminal, isReady, parseOrcaOutput, parsePayload,
  workerStartArgs, worktreePathOf,
} from "../src/exec/orca/client";
import { fail, fakeRun, fixture, ok, raw } from "./fixtures/orca/fake";

const O = (...a: string[]) => ["orca", ...a];

test("parseOrcaOutput drops keepalive lines and parses the final pretty-printed JSON", () => {
  const env = parseOrcaOutput(fixture("check-1.ndjson")) as { ok: boolean; result: CheckResult };
  expect(env.ok).toBe(true);
  expect(env.result.deliveryId).toBe("delivery_06976e286cc1");
  const m = env.result.messages[0];
  expect(m.type).toBe("worker_done");
  expect(parsePayload(m)).toMatchObject({ dispatchId: "ctx_802297d1724f", outcome: "succeeded" });
  expect(parseOrcaOutput("")).toBeNull();
  expect(parseOrcaOutput("not json")).toBeNull();
});

test("a timed-out wait parses to an empty batch", async () => {
  const f = fakeRun([[O("orchestration", "check"), ok("check-w5a.ndjson")]]);
  const r = await new OrcaClient(f.run).check({ terminal: "term_c", run: "run_1", waitMs: 30_000 });
  expect(r.ok && r.result).toMatchObject({ deliveryId: null, messages: [], timedOut: true });
});

test("envelopes: ok, ok:false with a code, missing binary, unparseable output", async () => {
  const f = fakeRun([
    [O("orchestration", "worker-release"), fail("worker-release-t1-freeplan.json")],
    [O("status"), raw("", 127, "Executable not found in $PATH: \"orca\"")],
    [O("repo", "list"), raw("Orca is not running\n", 1)],
    [O("orchestration", "worker-stop"), ok("worker-stop-t8-cursor-limit.json")],
  ]);
  const c = new OrcaClient(f.run);
  const rel = await c.workerRelease("ctx_c02eccc648eb");
  expect(rel.ok).toBe(false);
  if (!rel.ok) {
    expect(rel.error.code).toBe("dispatch_inactive");
    expect(rel.error.message).toContain("only a settled worker can release");
  }
  expect(f.calls[0]).toEqual(["orca", "orchestration", "worker-release", "--dispatch", "ctx_c02eccc648eb", "--json"]);
  const st = await c.status();
  expect(st.ok ? "" : st.error.code).toBe("not_installed");
  const rl = await c.repoList();
  expect(rl.ok ? null : rl.error).toEqual({ code: "bad_output", message: "Orca is not running" });
  const stop = await c.workerStop("ctx_bba4856d2d41");
  expect(stop.ok && stop.result.state).toBe("stopped");
});

test("every verb builds the verified argv and ends with --json", async () => {
  const f = fakeRun([[["orca"], raw('{"ok":true,"result":{}}')]]);
  const c = new OrcaClient(f.run);
  await c.status();
  await c.repoList();
  await c.repoAdd("/r");
  await c.terminalCreate("path:/r", "pacer coordinator");
  await c.terminalShow("term_a");
  await c.terminalClose("term_a");
  await c.terminalEnter("term_a");
  await c.runCreate("pacer executors", "term_c");
  await c.runShow("run_1");
  await c.workerShow("ctx_1");
  await c.workerRead("ctx_1", 60);
  await c.workerStop("ctx_1");
  await c.workerRelease("ctx_1");
  await c.reply({ id: "msg_1", body: "b", run: "run_1", from: "term_c" });
  await c.check({ terminal: "term_c", run: "run_1", waitMs: 30_000, ack: "delivery_z" });
  await c.check({ terminal: "term_c", run: "run_1", waitMs: null, ack: "delivery_z" });
  expect(f.calls).toEqual([
    ["orca", "status", "--json"],
    ["orca", "repo", "list", "--json"],
    ["orca", "repo", "add", "--path", "/r", "--json"],
    ["orca", "terminal", "create", "--worktree", "path:/r", "--title", "pacer coordinator", "--json"],
    ["orca", "terminal", "show", "--terminal", "term_a", "--json"],
    ["orca", "terminal", "close", "--terminal", "term_a", "--json"],
    ["orca", "terminal", "send", "--terminal", "term_a", "--enter", "--json"],
    ["orca", "orchestration", "run-create", "--objective", "pacer executors", "--from", "term_c", "--json"],
    ["orca", "orchestration", "run-show", "--id", "run_1", "--json"],
    ["orca", "orchestration", "worker-show", "--dispatch", "ctx_1", "--json"],
    ["orca", "orchestration", "worker-read", "--dispatch", "ctx_1", "--limit", "60", "--json"],
    ["orca", "orchestration", "worker-stop", "--dispatch", "ctx_1", "--json"],
    ["orca", "orchestration", "worker-release", "--dispatch", "ctx_1", "--json"],
    ["orca", "orchestration", "reply", "--id", "msg_1", "--body", "b", "--run", "run_1", "--from", "term_c", "--json"],
    ["orca", "orchestration", "check", "--ack", "delivery_z", "--wait", "--types", "worker_done,escalation,question",
      "--timeout-ms", "30000", "--terminal", "term_c", "--run", "run_1", "--json"],
    ["orca", "orchestration", "check", "--ack", "delivery_z", "--terminal", "term_c", "--run", "run_1", "--json"],
  ]);
  expect(f.timeouts[0]).toBe(15_000);
  expect(f.timeouts[14]).toBe(60_000);
  expect(f.timeouts[15]).toBe(30_000);
});

test("workerStartArgs: new-child and existing placements", () => {
  expect(workerStartArgs({
    spec: "S", agent: "cursor", model: "auto", run: "run_1", from: "term_c",
    placement: { kind: "new-child", repoId: "repo-1", baseBranch: "main", name: "pacer-t-1-cursor" },
  })).toEqual([
    "orchestration", "worker-start", "--spec", "S", "--agent", "cursor", "--model", "auto",
    "--worktree", "new-child", "--repo", "id:repo-1", "--base-branch", "main", "--name", "pacer-t-1-cursor", "--setup", "skip",
    "--run", "run_1", "--from", "term_c",
  ]);
  expect(workerStartArgs({
    spec: "S", agent: "codex", model: null, run: "run_1", from: "term_c",
    placement: { kind: "existing", selector: "path:/work/app" },
  })).toEqual([
    "orchestration", "worker-start", "--spec", "S", "--agent", "codex", "--worktree", "path:/work/app", "--run", "run_1", "--from", "term_c",
  ]);
});

test("worker-start receipts: a failed start is ok:true with failedStage/lastError; effects give worktree and terminal", async () => {
  const f = fakeRun([[O("orchestration", "worker-start"), [fail("worker-start-t1.json"), ok("worker-start-t2.json")]]]);
  const c = new OrcaClient(f.run);
  const opts = { spec: "S", agent: "cursor", model: null, run: "run_1", from: "term_c", placement: { kind: "existing" as const, selector: "path:/r" } };
  const failed = await c.workerStart(opts);
  expect(failed.ok).toBe(true);
  if (failed.ok) {
    expect(failed.result).toMatchObject({ dispatchId: "ctx_2da746213039", state: "failed", failedStage: "dispatch_input", lastError: "agent_not_in_foreground" });
    expect(worktreePathOf(failed.result.effects)).toBe("~/worktrees/pacer-exec-t1");
    expect(agentTerminalOf(failed.result.effects)).toBe("term_0249bbd0-4ff1-4ea0-9bcd-4b89f3463b82");
  }
  const ready = await c.workerStart(opts);
  if (!ready.ok) throw new Error("expected ok");
  expect(ready.result.state).toBe("ready");
  expect(worktreePathOf(ready.result.effects)).toBe("~/worktrees/pacer-exec-t2");
  expect(f.timeouts[0]).toBe(240_000);
  expect(worktreePathOf(undefined)).toBeNull();
  expect(agentTerminalOf([])).toBeNull();
});

test("isReady and isLiveTerminal", async () => {
  const f = fakeRun([
    [O("status"), [ok("status-ready.json"), ok("status-down.json"), raw("", 1)]],
    [O("terminal", "show"), [ok("terminal-show-live.json"), ok("terminal-show-closed.json"), fail("terminal-show-stale.json")]],
  ]);
  const c = new OrcaClient(f.run);
  expect(isReady(await c.status())).toBe(true);
  expect(isReady(await c.status())).toBe(false);
  expect(isReady(await c.status())).toBe(false);
  expect(isLiveTerminal(await c.terminalShow("h"))).toBe(true);
  expect(isLiveTerminal(await c.terminalShow("h"))).toBe(false);
  expect(isLiveTerminal(await c.terminalShow("h"))).toBe(false);
});

test("parsePayload tolerates missing and malformed payloads", () => {
  expect(parsePayload({ id: "m", type: "heartbeat", payload: null })).toBeNull();
  expect(parsePayload({ id: "m", type: "heartbeat", payload: "{oops" })).toBeNull();
  expect(parsePayload({ id: "m", type: "heartbeat", payload: "[1]" })).toBeNull();
});

test("orca CLI strips inherited caller attestation but retains runtime discovery environment",async()=>{
 const env={PATH:"/bin",HOME:"/tmp",ORCA_CLI_COMMAND:"orca",ORCA_USER_DATA_PATH:"/data",ORCA_AGENT_SESSION_ID:"caller",ORCA_AGENT_SESSION_ID_ENV:"CUSTOM_SESSION",CUSTOM_SESSION:"secret",ORCA_TERMINAL_HANDLE:"term_caller",ORCA_PANE_KEY:"pane",ORCA_TAB_ID:"tab",ORCA_WORKTREE_ID:"wt",ORCA_AGENT_LAUNCH_TOKEN:"token",ORCA_AGENT_HOOK_TEST:"hook",ORCA_SESSION_TEST:"session"};
 let received:any;const run=async(_argv:string[],_timeout:number,options:any)=>{received=options.env;return{code:0,stdout:JSON.stringify({ok:true,result:{}}),stderr:""};};
 await new OrcaClient(run,env).status();expect(received).toEqual({PATH:"/bin",HOME:"/tmp",ORCA_CLI_COMMAND:"orca",ORCA_USER_DATA_PATH:"/data"});expect(env.CUSTOM_SESSION).toBe("secret");
});
