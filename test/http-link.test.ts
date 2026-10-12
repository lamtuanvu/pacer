import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "../src/serve/http";
import { publish } from "../src/link/publish";
import { writeConsole } from "../src/link/store";
import { latestPath } from "../src/link/paths";
import type { Envelope } from "../src/link/envelope";
import { fakeCtx } from "./helpers";

let stops: (() => void)[] = [];
afterEach(() => { for (const stop of stops.splice(0)) stop(); });

async function serve(opts: { tailMs?: number; pumpMs?: number } = {}) {
  const ctx = fakeCtx();
  await Bun.write(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n");
  const s = startServer(() => ctx, { port: 0, ...opts });
  stops.push(s.stop);
  const headers = { authorization: `Bearer ${s.token}` };
  return { ctx, ...s, headers, url: `http://127.0.0.1:${s.port}` };
}

test("/link is token gated and returns the current snapshot", async () => {
  const { url, headers } = await serve();
  expect((await fetch(`${url}/link`)).status).toBe(401);
  expect(await (await fetch(`${url}/link`, { headers })).json()).toMatchObject({ v: 1, seq: 0, console: null });
});

test("/link includes published tasks and a fresh console heartbeat", async () => {
  const { ctx, url, headers } = await serve();
  const task = { id: "t1", state: "running", goal: "ship it", executor: null, backend: null, worktree: null, updatedAt: ctx.now };
  await publish(ctx, [{ v: 1, type: "task", data: task }], { bridge: false, channel: false });
  writeConsole(ctx, { handle: "term-1", paneKey: "pane-1", pid: process.pid, startedAt: ctx.now, heartbeatAt: ctx.now });
  const deadline = Date.now() + 3000;
  let snap = await (await fetch(`${url}/link`, { headers })).json();
  while ((snap.tasks[0]?.id !== "t1" || snap.console?.handle !== "term-1") && Date.now() < deadline) {
    await Bun.sleep(10);
    snap = await (await fetch(`${url}/link`, { headers })).json();
  }
  expect(snap.tasks[0]?.id).toBe("t1");
  expect(snap.console.handle).toBe("term-1");
});

test("/events tails newly published envelopes after its initial budget", async () => {
  const { ctx, url, headers } = await serve({ tailMs: 20 });
  const r = await fetch(`${url}/events`, { headers });
  const reader = r.body!.getReader();
  await reader.read();
  const alert: Envelope = { v: 1, type: "alert", data: { key: "x", level: "info", title: "hello", body: "world", at: ctx.now } };
  await publish(ctx, [alert], { bridge: false, channel: false });
  const read = reader.read();
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), 500));
  const next = await Promise.race([read, timeout]);
  expect(new TextDecoder().decode(next.value).includes('"key":"x"')).toBe(true);
  await reader.cancel();
});

test("/events sends budget projections without executor details", async () => {
  const { url, headers } = await serve();
  const r = await fetch(`${url}/events`, { headers });
  const reader = r.body!.getReader();
  const first = await reader.read();
  const msg = JSON.parse(new TextDecoder().decode(first.value).slice(6).trim());
  expect(msg.data.providers[0].usedPct === null || typeof msg.data.providers[0].usedPct === "number").toBe(true);
  expect(msg.data).toHaveProperty("ranked");
  expect(msg.data).not.toHaveProperty("executors");
  await reader.cancel();
});

test("pump runs on its timer and stop clears it", async () => {
  const { ctx } = await serve({ pumpMs: 30 });
  const path = latestPath(ctx);
  const deadline = Date.now() + 300;
  while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(5);
  expect(existsSync(path)).toBe(true);
  const before = statSync(path).mtimeMs;
  for (const stop of stops.splice(0)) stop();
  await Bun.sleep(100);
  expect(statSync(path).mtimeMs).toBe(before);
});

test("/state still returns full Status", async () => {
  const { url, headers } = await serve();
  const state = await (await fetch(`${url}/state`, { headers })).json();
  expect(state).toHaveProperty("executors");
});

test("/link serves cached data without context lookup", async () => {
  const ctx = fakeCtx(); let fail = false;
  const server = startServer(() => { if (fail) throw Error("context unavailable"); return ctx; }, {port:0,pumpMs:0});
  stops.push(server.stop); fail = true;
  const response = await fetch(`http://127.0.0.1:${server.port}/link`, {headers:{authorization:`Bearer ${server.token}`}});
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toMatchObject({v:1,seq:0});
});

test("pump timer contains synchronous context failure and can run again", async () => {
  const ctx = fakeCtx(); let calls=0, fail=true;
  const original = globalThis.setInterval;
  let tick!: () => void;
  globalThis.setInterval = ((fn: () => void) => {tick=fn;return original(()=>{},100000);}) as typeof setInterval;
  try {
    const server = startServer(() => {calls++; if(calls>1 && fail)throw Error("context unavailable");return ctx;}, {port:0,pumpMs:10});
    stops.push(server.stop);
    expect(() => tick()).not.toThrow();
    await Bun.sleep(10);fail=false;tick();
    const deadline=Date.now()+300;
    while(!existsSync(latestPath(ctx)) && Date.now()<deadline)await Bun.sleep(5);
    expect(existsSync(latestPath(ctx))).toBe(true);
  } finally {globalThis.setInterval=original;}
});

test("health is unauthenticated and pacer responses identify themselves",async()=>{
 const {url,headers}=await serve();
 const health=await fetch(url+"/health");
 expect(health.status).toBe(200);expect(health.headers.get("x-pacer")).toBe("1");
 expect(await health.json()).toEqual({ok:true,pid:process.pid});
 for(const path of ["/link","/state"]) expect((await fetch(url+path,{headers})).headers.get("x-pacer")).toBe("1");
});

test("five-second usage refresh does not delay health or link requests",async()=>{
 const ctx=fakeCtx();await Bun.write(join(ctx.pacerHome,"strategy.yaml"),"planner: claude-code\nproviders:\n  claude-code: {usage: reactive}\n  byteplus: {via: opencode, model: coding-plan/test, usage: quota, quota_source: arkcli}\n");
 let started=false;const slow=Bun.sleep(5000);
 ctx.run=async(argv)=>{if(argv[0]==="arkcli"){started=true;await slow;}return {code:0,stdout:'{"items":[]}',stderr:""};};
 let contexts=0;const server=startServer(()=>{contexts++;return ctx;},{port:0,pumpMs:10});stops.push(server.stop);
 try {
  await Bun.sleep(20);expect(started).toBe(true);
  const before=contexts;
  const start=performance.now();
  const responses=await Promise.all([fetch(`http://127.0.0.1:${server.port}/health`),fetch(`http://127.0.0.1:${server.port}/link`,{headers:{authorization:`Bearer ${server.token}`}})]);
  expect(responses.map(r=>r.status)).toEqual([200,200]);expect(performance.now()-start).toBeLessThan(100);expect(contexts).toBe(before);
  const noIo=ctx.run;ctx.run=async()=>{throw Error("HTTP requested I/O");};
  expect((await fetch(`http://127.0.0.1:${server.port}/link`,{headers:{authorization:`Bearer ${server.token}`}})).status).toBe(200);ctx.run=noIo;
 }finally{await slow;}
},15000);

test("console actions are admitted promptly while Orca is slow",async()=>{
 const ctx=fakeCtx();let release!:()=>void;
 const slow=new Promise<void>(r=>{release=r;});let calls=0;
 ctx.run=async()=>{calls++;await slow;return {code:1,stdout:"",stderr:"offline"};};
 const server=startServer(()=>ctx,{port:0,pumpMs:0});stops.push(server.stop);
 try {
  const start=performance.now();
  const r=await fetch(`http://127.0.0.1:${server.port}/console/open`,{method:"POST",headers:{authorization:`Bearer ${server.token}`,"content-type":"application/json"},body:JSON.stringify({branch:"main"})});
  expect(r.status).toBe(202);expect(await r.json()).toEqual({ok:true,queued:true});expect(performance.now()-start).toBeLessThan(100);
  await Bun.sleep(10);expect(calls).toBeGreaterThan(0);
 }finally{release();await Bun.sleep(10);}
});
