import { thread, getMessage } from "../src/messaging/store";
import { createServer } from "node:net";
import { ViewerHub } from "../src/session/viewers";
import { wire, FrameType } from "../src/session/framing";
import { registerWork, listWork, workTree } from "../src/dispatch/work";
import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { activeDeadlineExpired } from "../src/supervisor/active-time";
import { startRun, stopRun, readRun, type RunState } from "../src/supervisor/run";
import { supervise } from "../src/supervisor/supervise";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { list as listTasks, answer, ask } from "../src/core/tasks";
import { taskData } from "../src/link/pump";
import { apiTask } from "../src/api/read-model/tasks";
import { legacyQuestionPending } from "../app/src/model/task-answer";
import { send } from "../src/session/send";
import { fakeCtx, tmpDir } from "./helpers";

const state = (status: "running" | "needs-input" | "turn-ended", at: number): RunState => ({
  pid: 1, startedAt: 0, exit: null, alive: true, stdoutBytes: 0, stderrBytes: 0,
  lastOutputAt: null, interactive: true, report: {status, at: at / 1000, summary: status},
});

test("input wait budget survives reattachment both while waiting and after an answered wait", () => {
  const dir = tmpDir(), base = 1000;
  expect(activeDeadlineExpired(dir, base, state("running", 0), 100)).toBe(false);
  expect(activeDeadlineExpired(dir, base, state("needs-input", 200), 200)).toBe(false);
  expect(activeDeadlineExpired(dir, base, state("needs-input", 200), 50_000)).toBe(false);
  // Each call reloads durable state, including a fresh supervisor after an answer.
  expect(activeDeadlineExpired(dir, base, state("running", 50_000), 50_000)).toBe(false);
  expect(activeDeadlineExpired(dir, base, state("running", 50_000), 50_799)).toBe(false);
  expect(activeDeadlineExpired(dir, base, state("running", 50_000), 50_800)).toBe(true);
});

test("a turn-ended terminal outlives deadline and idle/asked polls but explicit stop still works", async () => {
  let polls = 0, stops = 0;
  const result = await supervise({runDir: tmpDir(), deadlineMs: 10, now: () => 1000,
    io: {read: async () => state("turn-ended", 5), stop: async () => {stops++; return {code:143,killed:false};}},
    isStopped: () => polls === 3, onPoll: async () => {polls++; return polls === 1 ? "asked" : "idle";}, sleep: async () => {}});
  expect(result.kind).toBe("stopped");
  expect(polls).toBe(3); expect(stops).toBe(1);
});

test("built-in PTY accepts send and two app answers on one still-owned attempt", async () => {
  const ctx = fakeCtx(), dir = tmpDir();
  const task = createTask(ctx, {brief:{goal:"answer twice",repo:tmpDir()},kind:null,requestedExecutor:null,timeoutS:1});
  startRun({dir,argv:["sh","-c","cat"],cwd:dir,env:{PATH:process.env.PATH},session:"interactive"});
  try {
    const until = Date.now() + 5000;
    while ((!readRun(dir).alive || !existsSync(join(dir,"session.sock"))) && Date.now() < until) await Bun.sleep(25);
    updateTask(ctx,task.id,t=>{t.state="running";t.run={dir,attempt:1,executor:"codex",startedAt:Date.now()/1000,mode:"current",workdir:t.brief.repo,logFile:join(dir,"log")};});
    await send(ctx,task.id,"hello");
    await ask(ctx,task.id,"socket unavailable?");
    const original = join(dir,"session.sock");
    writeFileSync(join(dir,"session.sock.path"),join(dir,"missing.sock"));
    await expect(answer(ctx,task.id,"try once")).rejects.toThrow("Interactive input failed");
    expect(readTask(ctx,task.id)!.question!.answer).toBeUndefined();
    writeFileSync(join(dir,"session.sock.path"),original);
    await answer(ctx,task.id,"socket restored");
    for (let n=1;n<=2;n++) {
      await ask({...ctx,now:ctx.now+n},task.id,`question ${n}`);
      const stored = readTask(ctx,task.id)!;
      expect(stored.state).toBe("running");
      await expect(send(ctx,task.id,"bypass the question")).rejects.toThrow(`use pacer answer ${task.id}`);
      expect(readTask(ctx,task.id)!.question!.answer).toBeUndefined();
      expect(taskData(stored).state).toBe("needs_input");
      const view = apiTask(ctx,stored);
      expect(legacyQuestionPending({...view,work:null} as never)).toBe(true);
      const result = await answer(ctx,task.id,`answer ${n}`,{expectRev:stored.rev});
      expect(result.task.id).toBe(task.id); expect(result.retry.id).toBe(task.id);
      expect(result.task.state).toBe("running");
      expect(readTask(ctx,task.id)!.run!.dir).toBe(dir);
      expect(readRun(dir).alive).toBe(true);
      expect(readTask(ctx,task.id)!.question!.answer).toBe(`answer ${n}`);
    }
  } finally { await stopRun(dir,{graceMs:500}); }
});

test("reattachment charges work since a running report and does not backdate controller waits", () => {
  const dir = tmpDir();
  activeDeadlineExpired(dir, 60_000, state("needs-input", 10_000), 10_000);
  // 40 seconds waiting, 60 seconds active: expired at 100s even though first reobservation is now.
  expect(activeDeadlineExpired(dir, 60_000, state("running", 50_000), 100_000)).toBe(true);
  const controlled = tmpDir();
  expect(activeDeadlineExpired(controlled, 60_000, {...state("running", 0),controller:"viewer"}, 50_000)).toBe(false);
  expect(activeDeadlineExpired(controlled, 60_000, {...state("running", 0),lastInputAt:55}, 55_000)).toBe(false);
  expect(activeDeadlineExpired(controlled, 60_000, state("running", 55_000), 65_000)).toBe(true);
});

test("task and dispatch waiting filters apply before pagination while ownership stays running", () => {
  const ctx = fakeCtx(), repo = tmpDir();
  const waiting: string[] = [];
  for (let n=0;n<4;n++) {
    const t = createTask({...ctx,now:ctx.now+n},{brief:{goal:`task ${n}`,repo},kind:null,requestedExecutor:null,timeoutS:60});
    registerWork(ctx,t.id,{});
    updateTask(ctx,t.id,x=>{x.state="running";if(n%2===0)x.question={text:`question ${n}`,at:ctx.now+n};});
    if(n%2===0) waiting.unshift(t.id);
  }
  expect(listTasks(ctx,{states:["needs_input"],limit:1}).map(t=>t.id)).toEqual(waiting.slice(0,1));
  const first = listWork(ctx,{state:"needs_input",limit:1});
  expect(first.tasks.map(t=>t.id)).toEqual(waiting.slice(0,1));
  expect(listWork(ctx,{state:"needs_input",before:first.next!,limit:1}).tasks.map(t=>t.id)).toEqual(waiting.slice(1));
  expect(workTree(ctx,waiting[0]).nodes[0].state).toBe("needs_input");
  expect(readTask(ctx,waiting[0])!.state).toBe("running");
});

test("answer reservation lets the agent ask its next question immediately on terminal submit", async () => {
  const ctx=fakeCtx(),dir=tmpDir();
  const t=createTask(ctx,{brief:{goal:"fast next question",repo:tmpDir()},kind:null,requestedExecutor:null,timeoutS:60});
  startRun({dir,argv:["sh","-c","cat"],cwd:dir,env:{PATH:process.env.PATH},session:"interactive"});
  let next: Promise<unknown> | undefined;
  const hub=new ViewerHub(()=>wire(FrameType.snapshot,{}),()=>null,fn=>fn(),()=>{},()=>{}, {
    input:bytes=>{if(bytes.toString()==="\r") next=ask({...ctx,now:ctx.now+1},t.id,"next question");}, resize(){}, release(){}
  });
  const server=createServer(socket=>hub.add(socket));
  const socket=join(tmpDir(),"input.sock");
  try {
    while(!readRun(dir).alive) await Bun.sleep(25);
    await new Promise<void>(resolve=>server.listen(socket,resolve));
    writeFileSync(join(dir,"session.sock.path"),socket);
    updateTask(ctx,t.id,x=>{x.state="running";x.origin="human";x.run={dir,attempt:1,executor:"codex",startedAt:1,mode:"current",workdir:x.brief.repo,logFile:join(dir,"log")};});
    await ask(ctx,t.id,"first question");
    const original=thread(ctx,t.id).find(m=>m.kind==="question")!;
    expect(apiTask(ctx,readTask(ctx,t.id)!).messages?.question?.id).toBe(original.id);
    await answer(ctx,t.id,"first answer");
    await next;
    expect(readTask(ctx,t.id)!.question).toEqual({text:"next question",at:ctx.now+1});
    expect(getMessage(ctx,original.id)!.status).toBe("read");
    const followup=thread(ctx,t.id).find(m=>m.kind==="question" && m.id!==original.id)!;
    expect(getMessage(ctx,followup.id)!.status).toBe("pending");
    expect(apiTask(ctx,readTask(ctx,t.id)!).messages?.question?.id).toBe(followup.id);
    expect(taskData(readTask(ctx,t.id)!).state).toBe("needs_input");
  } finally {hub.destroy();server.close();await stopRun(dir,{graceMs:500});}
});
