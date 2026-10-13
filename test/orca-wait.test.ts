import { expect, test } from "bun:test";
import { OrcaClient } from "../src/exec/orca/client";
import { hasInbox, putInbox, takeInbox } from "../src/exec/orca/state";
import { NO_ANSWER, type WaitOpts, needsSubmit, waitForWorker } from "../src/exec/orca/wait";
import { fakeCtx } from "./helpers";
import { type FakeRun, type Route, fakeRun, ok, raw } from "./fixtures/orca/fake";

const O = (...a: string[]) => ["orca", ...a];
const COORD = "term_1ddadcbd-780e-4951-b184-c51193ff39c6";
const RUN = "run_9d54b4f3810a";
const arg = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];
const checks = (f: FakeRun) => f.calls.filter((a) => a[1] === "orchestration" && a[2] === "check");

function setup(routes: Route[], over: Partial<WaitOpts> = {}) {
  const f = fakeRun([...routes, [O("orchestration", "worker-read"), raw('{"ok":true,"result":{"terminal":{"tail":["Working"]}}}')]]);
  const ctx = fakeCtx({ run: f.run });
  const sleeps: number[] = [];
  const opts: WaitOpts = {
    coordinator: COORD, run: RUN, dispatchId: "ctx_802297d1724f", terminal: null,
    deadlineMs: Date.now() + 600_000, isStopped: () => false, sliceMs: 30_000,
    sleep: async (ms) => { sleeps.push(ms); },
    ...over,
  };
  return { f, ctx, c: new OrcaClient(f.run), opts, sleeps };
}

test("a worker_done in a later batch ends the wait; each batch is acked on the next check; other workers' results go to the inbox", async () => {
  const { f, ctx, c, opts } = setup([
    [O("terminal", "show"), ok("terminal-show-live.json")],
    [O("orchestration", "check"), [ok("check-w2a.ndjson"), ok("check-w2b.ndjson"), ok("ack-1.json")]],
    [O("orchestration", "worker-show"), ok("worker-show-ready.json")],
  ], { dispatchId: "ctx_df599d4e7101", terminal: "term_563674c8-c109-455e-a291-35acf015d00c" });
  const r = await waitForWorker(ctx, c, opts);
  expect(r).toMatchObject({
    kind: "done", outcome: "succeeded", subject: "Task 2 process exec done",
    filesModified: ["src/exec/process.ts", "test/process.test.ts"],
  });
  const cs = checks(f);
  expect(cs).toHaveLength(3);
  expect(cs[0]).not.toContain("--ack");
  expect(arg(cs[0], "--types")).toBe("worker_done,escalation,question");
  expect(arg(cs[0], "--terminal")).toBe(COORD);
  expect(arg(cs[0], "--run")).toBe(RUN);
  expect(arg(cs[1], "--ack")).toBe("delivery_452d94649d62");
  expect(arg(cs[2], "--ack")).toBe("delivery_c9e4a782bd92");
  expect(cs[2]).not.toContain("--wait");
  expect(takeInbox(ctx, "ctx_28ca2bdd914b")?.subject).toBe("Task 3 done");
  expect(takeInbox(ctx, "ctx_6e7a3c641b1f")?.outcome).toBe("succeeded");
  expect(hasInbox(ctx, "ctx_df599d4e7101")).toBe(false);
});

test("a result another runner already received is taken from the inbox without calling orca", async () => {
  const { f, ctx, c, opts } = setup([], { dispatchId: "ctx_28ca2bdd914b" });
  putInbox(ctx, "ctx_28ca2bdd914b", { outcome: "succeeded", subject: "Task 3 done", body: "b", filesModified: [], messageId: "msg_437d402477ce" });
  expect(await waitForWorker(ctx, c, opts)).toEqual({ kind: "done", outcome: "succeeded", subject: "Task 3 done", body: "b", filesModified: [] });
  expect(f.calls).toHaveLength(0);
});

test("a pasted but unsubmitted prompt is submitted with one Enter", async () => {
  const term = "term_a225e7a8-0e55-4cb9-8e30-be7da4952e5d";
  const { f, ctx, c, opts } = setup([
    [O("terminal", "show"), ok("terminal-show-pasted.json")],
    [O("terminal", "send"), ok("terminal-send.json")],
    [O("orchestration", "check"), [ok("check-w5a.ndjson"), ok("check-1.ndjson"), ok("ack-1.json")]],
    [O("orchestration", "worker-show"), ok("worker-show-ready.json")],
  ], { terminal: term });
  const lines: string[] = [];
  const r = await waitForWorker(ctx, c, { ...opts, log: (l) => lines.push(l) });
  expect(r.kind).toBe("done");
  expect(f.count(O("terminal", "send"))).toBe(1);
  expect(f.calls.find((a) => a[2] === "send")).toEqual(["orca", "terminal", "send", "--terminal", term, "--enter", "--json"]);
  expect(f.count(O("terminal", "show"))).toBe(1);
  expect(lines.join("\n")).toContain("pasted but not submitted");
});

test("a working terminal that shows pasted text is not nudged", async () => {
  expect(needsSubmit("[Pasted text #1 +3 lines]")).toBe(true);
  expect(needsSubmit("[Pasted text #1 +3 lines]  ctrl+c to stop")).toBe(false);
  expect(needsSubmit("$")).toBe(false);
  const { f, ctx, c, opts } = setup([
    [O("terminal", "show"), ok("terminal-show-working.json")],
    [O("orchestration", "check"), [ok("check-1.ndjson"), ok("ack-1.json")]],
  ], { terminal: "term_a225e7a8-0e55-4cb9-8e30-be7da4952e5d" });
  expect((await waitForWorker(ctx, c, opts)).kind).toBe("done");
  expect(f.count(O("terminal", "send"))).toBe(0);
});

test("a worker that settles failed without a worker_done ends the wait with its error", async () => {
  const { ctx, c, opts } = setup([
    [O("orchestration", "check"), ok("check-w5a.ndjson")],
    [O("orchestration", "worker-show"), ok("worker-show-failed.json")],
  ], { dispatchId: "ctx_2da746213039" });
  expect(await waitForWorker(ctx, c, opts)).toEqual({ kind: "settled", state: "failed", error: "agent_not_in_foreground" });
});

test("a succeeded worker gets two more passes for its report, then settles", async () => {
  const { f, ctx, c, opts } = setup([
    [O("orchestration", "check"), ok("check-w5a.ndjson")],
    [O("orchestration", "worker-show"), ok("worker-show-succeeded.json")],
  ]);
  expect(await waitForWorker(ctx, c, opts)).toEqual({ kind: "settled", state: "succeeded", error: null });
  expect(f.count(O("orchestration", "worker-show"))).toBe(3);
});

test("the deadline bounds each wait slice and ends the wait as timeout", async () => {
  let t = 0;
  const { f, ctx, c, opts } = setup([
    [O("orchestration", "check"), () => { t = 5_000; return ok("check-w5a.ndjson"); }],
    [O("orchestration", "worker-show"), ok("worker-show-ready.json")],
  ], { now: () => t, deadlineMs: 1_000 });
  expect(await waitForWorker(ctx, c, opts)).toEqual({ kind: "timeout" });
  expect(arg(checks(f)[0], "--timeout-ms")).toBe("1000");
});

test("a stopped task ends the wait as stopped", async () => {
  let stopped = false;
  const { ctx, c, opts } = setup([
    [O("orchestration", "check"), () => { stopped = true; return ok("check-w5a.ndjson"); }],
    [O("orchestration", "worker-show"), ok("worker-show-ready.json")],
  ], { isStopped: () => stopped });
  expect(await waitForWorker(ctx, c, opts)).toEqual({ kind: "stopped" });
});

test("a question gets one standard reply even when its batch replays", async () => {
  const { f, ctx, c, opts } = setup([
    [O("orchestration", "check"), [ok("check-question.ndjson"), ok("check-question.ndjson"), ok("check-1.ndjson"), ok("ack-1.json")]],
    [O("orchestration", "reply"), ok("reply.json")],
    [O("orchestration", "worker-show"), ok("worker-show-ready.json")],
  ]);
  expect((await waitForWorker(ctx, c, opts)).kind).toBe("done");
  expect(f.count(O("orchestration", "reply"))).toBe(1);
  expect(f.calls.find((a) => a[2] === "reply")).toEqual([
    "orca", "orchestration", "reply", "--id", "msg_q00000000001", "--body", NO_ANSWER, "--run", RUN, "--from", COORD, "--json",
  ]);
  expect(arg(checks(f)[1], "--ack")).toBe("delivery_q00000000001");
});

test("a failing check backs off and keeps waiting", async () => {
  const { ctx, c, opts, sleeps } = setup([
    [O("orchestration", "check"), [raw("", 1, "connect ECONNREFUSED"), ok("check-1.ndjson"), ok("ack-1.json")]],
    [O("orchestration", "worker-show"), ok("worker-show-ready.json")],
  ]);
  expect((await waitForWorker(ctx, c, opts)).kind).toBe("done");
  expect(sleeps).toEqual([5_000]);
});

function monitor(tail: (at:number) => string[], over: Partial<WaitOpts> = {}) {
 let at=0;const logs:string[]=[];
 const f=fakeRun([
  [O("orchestration","check"),()=>{at+=30000;return raw(JSON.stringify({ok:true,result:{messages:[]}}));}],
  [O("orchestration","worker-read"),()=>raw(JSON.stringify({ok:true,result:{terminal:{tail:tail(at)}}}))],
  [O("orchestration","worker-show"),ok("worker-show-ready.json")],
  [O("terminal","show"),raw(JSON.stringify({ok:true,result:{terminal:{preview:"› "}}}))],
  [O("terminal","send"),raw(JSON.stringify({ok:true,result:{accepted:true}}))],
 ]);
 const ctx=fakeCtx({run:f.run}),c=new OrcaClient(f.run);
 const opts:WaitOpts={coordinator:COORD,run:RUN,dispatchId:"ctx_busy",terminal:"term_busy",deadlineMs:2000000,isStopped:()=>false,now:()=>at,sleep:async ms=>{at+=ms;},log:l=>logs.push(l),prompt:"Complete the assigned brief",...over};
 return {ctx,c,opts,f,logs,at:()=>at};
}
test("capacity errors resend the brief to the same terminal with 60/120/240 backoff, then fail transiently",async()=>{
 const h=monitor(()=>["■ Selected model is at capacity. Please try a different model.","› "]);
 const r=await waitForWorker(h.ctx,h.c,h.opts);expect(r).toMatchObject({kind:"settled",state:"failed",error:"transient provider busy after three retries",needsStop:true});
 const sends=h.f.calls.filter(a=>a[1]==="terminal"&&a[2]==="send");expect(sends).toHaveLength(3);
 for(const send of sends){expect(arg(send,"--terminal")).toBe("term_busy");expect(arg(send,"--text")).toContain("Complete the assigned brief");expect(send).toContain("--enter");}
 expect(h.logs.filter(l=>l.includes("resend"))).toHaveLength(3);expect(h.at()).toBe(510000);
});
test("idle prompt gets one nudge after ten minutes then fails after ten more",async()=>{
 const h=monitor(()=>["› "]);const r=await waitForWorker(h.ctx,h.c,h.opts);
 expect(r).toMatchObject({kind:"settled",error:"worker idle with no progress",needsStop:true});
 const sends=h.f.calls.filter(a=>a[1]==="terminal"&&a[2]==="send");expect(sends).toHaveLength(1);expect(arg(sends[0],"--text")).toBe("continue the assigned task; report when done");expect(h.logs[0]).toContain("worker idle: nudge");
 expect(h.at()).toBe(1260000);
});
test("new output and active working indicator reset idle observation; absent tail never proves idle",async()=>{
 for(const tail of [(_at:number)=>["Working · esc to interrupt","› "],(at:number)=>[`output ${at}`,"› "],(_at:number)=>[]]){
  const h=monitor(tail,{deadlineMs:1400000});expect(await waitForWorker(h.ctx,h.c,h.opts)).toEqual({kind:"timeout"});expect(h.logs).toHaveLength(0);
 }
});
test("working output does not trigger busy retries; echoed busy brief text is excluded",async()=>{
 for(const [tail,prompt] of [[["Selected model is at capacity","esc to interrupt"],"task"],[["The task tests Selected model is at capacity","Working"],"The task tests Selected model is at capacity"]] as [string[],string][]){
  const h=monitor(()=>tail,{deadlineMs:800000,prompt});expect(await waitForWorker(h.ctx,h.c,h.opts)).toEqual({kind:"timeout"});expect(h.logs).toHaveLength(0);
 }
});
test("busy worker may recover and report before retries are exhausted",async()=>{
 const h=monitor(at=>at<120000?["Selected model is at capacity","› "]:["Working"]);
 const original=h.ctx.run;h.ctx.run=async(argv,timeout)=>{const r=await original(argv,timeout);if(h.at()>=120000&&argv[2]==="check")putInbox(h.ctx,"ctx_busy",{outcome:"succeeded",subject:"done",body:"done",filesModified:[],messageId:"msg_done"});return r;};
 const r=await waitForWorker(h.ctx,new OrcaClient(h.ctx.run),h.opts);expect(r).toMatchObject({kind:"done",outcome:"succeeded"});expect(h.logs.filter(l=>l.includes("resend"))).toHaveLength(1);
});

test("provider overload with a 429 is transient rather than quota exhaustion",async()=>{
 const h=monitor(()=>["429: model is overloaded", "› "]);const r=await waitForWorker(h.ctx,h.c,h.opts);
 expect(r).toMatchObject({kind:"settled",error:"transient provider busy after three retries"});expect(h.logs).toHaveLength(3);
});
