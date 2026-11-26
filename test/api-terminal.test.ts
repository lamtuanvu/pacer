import { expect, test } from "bun:test";
import { createSession } from "../src/serve/app-auth";
import { startServer } from "../src/serve/http";
import { callOp, opNames } from "../src/api/ops";
import { fakeCtx } from "./helpers";
import { createTerminal, listTerminals, terminalDirectory, terminalLivenessEvents } from "../src/terminal/workspace";
import { readOutboxSince } from "../src/link/store";
import { parseOutboxEvent } from "../src/link/envelope";
import { Recording } from "../src/session/recording";
import { FrameType, WireDecoder, wire } from "../src/session/framing";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const canBind = (() => { try { const server = Bun.serve({ port: 0, fetch: () => new Response("ok") }); server.stop(true); return true; } catch { return false; } })();

test("terminal operations create one shell, list it, rename with a revision and close it", async () => {
  const ctx = fakeCtx({ env: { ...process.env } });
  expect(opNames()).toContain("terminal.create");
  const created = await callOp(ctx, "terminal.create", { request_id: "api-shell-one", kind: "shell", cwd: ctx.home }) as { id: string; rev: number; attach: { ws: string } };
  try {
    expect(created.attach.ws).toBe(`/v3/terminals/${created.id}/session`);
    const again = await callOp(ctx, "terminal.create", { request_id: "api-shell-one", kind: "shell", cwd: ctx.home }) as { id: string };
    expect(again.id).toBe(created.id);
    expect((await callOp(ctx, "terminal.list", {}) as { id: string }[]).map(t => t.id)).toContain(created.id);
    const renamed = await callOp(ctx, "terminal.rename", { id: created.id, title: "Build shell", expect_rev: created.rev }) as { rev: number; title: string };
    expect(renamed.title).toBe("Build shell");
    await expect(callOp(ctx, "terminal.close", { id: created.id, expect_rev: created.rev })).rejects.toMatchObject({ code: "conflict" });
    await callOp(ctx, "terminal.close", { id: created.id, expect_rev: renamed.rev });
    expect(await callOp(ctx, "terminal.list", {})).toEqual([]);
  } finally {
    const all = await callOp(ctx, "terminal.list", {}) as { id: string; rev: number }[];
    const active = all.find(t => t.id === created.id);
    if (active) await callOp(ctx, "terminal.close", { id: active.id, expect_rev: active.rev });
  }
});

test("terminal create, rename and close publish terminal entity events and advance the marker", async () => {
  const ctx = fakeCtx({ env: { ...process.env } });
  const terminalEvents = () => readOutboxSince(ctx, 0).flatMap(entry => {
    const event = parseOutboxEvent(entry.envelope);
    return event?.type === "entity" && event.data.kind === "terminal" ? [event.data] : [];
  });
  const marker = (id: string) => JSON.parse(readFileSync(join(ctx.pacerHome, "terminals", id, "published.json"), "utf8"));
  const created = await callOp(ctx, "terminal.create", { request_id: "events-shell", kind: "shell", cwd: ctx.home }) as { id: string; rev: number; title: string };
  try {
    expect(terminalEvents()).toEqual([{ kind: "terminal", id: created.id, value: expect.objectContaining({ id: created.id, title: created.title }) }]);
    expect(marker(created.id)).toMatchObject({ rev: created.rev });
    const renamed = await callOp(ctx, "terminal.rename", { id: created.id, title: "Renamed", expect_rev: created.rev }) as { rev: number };
    expect(terminalEvents().map(event => event.id)).toEqual([created.id, created.id]);
    expect(terminalEvents()[1]?.value).toMatchObject({ id: created.id, title: "Renamed", rev: renamed.rev });
    expect(marker(created.id)).toMatchObject({ rev: renamed.rev });
    await callOp(ctx, "terminal.close", { id: created.id, expect_rev: renamed.rev });
    expect(terminalEvents()[2]).toEqual({ kind: "terminal", id: created.id, removed: true });
    expect(marker(created.id)).toEqual({ removed: true });
  } finally {
    const active = (await callOp(ctx, "terminal.list", {}) as { id: string; rev: number }[]).find(tab => tab.id === created.id);
    if (active) await callOp(ctx, "terminal.close", { id: active.id, expect_rev: active.rev });
  }
});

test("a failed terminal launch publishes the failed state before refusing", async () => {
  const ctx = fakeCtx({ env: { ...process.env } });
  await expect(createTerminal(ctx, { requestId: "failed-launch", kind: "shell", cwd: ctx.home }, { start: () => ({ error: "boom" }) })).rejects.toMatchObject({ code: "not_allowed" });
  const events = readOutboxSince(ctx, 0).flatMap(entry => parseOutboxEvent(entry.envelope));
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: "entity", data: { kind: "terminal", value: { live: false } } });
});

test("an exit after a fresh observer starts is published once; rename and close are not duplicated", async () => {
  // A fresh ctx with the same home models a restarted service or the background Worker: no
  // in-memory baseline exists, so the on-disk marker is the only source of truth.
  const ctx = fakeCtx({ env: { ...process.env } });
  const observer = fakeCtx({ home: ctx.home, pacerHome: ctx.pacerHome, env: { ...process.env } });
  const created = await createTerminal(ctx, { requestId: "exit-shell", kind: "shell", cwd: ctx.home }, { start: () => ({ pid: 99999999 }) });
  const pushed = async (c: typeof ctx) => (await terminalLivenessEvents(c)).flatMap(event => parseOutboxEvent(event));
  expect(await pushed(observer)).toEqual([]);
  writeFileSync(join(terminalDirectory(ctx, created.id), "exit"), "7");
  // A refetch racing the pump must not consume the exit signal.
  await listTerminals(observer);
  expect(await pushed(observer)).toEqual([{ type: "entity", data: { kind: "terminal", id: created.id, value: expect.objectContaining({ id: created.id, live: false, exit: 7 }) } }]);
  expect(await pushed(observer)).toEqual([]);
  // A rename on the "request thread" publishes once; the Worker does not repeat it.
  const renamed = await callOp(ctx, "terminal.rename", { id: created.id, title: "Renamed", expect_rev: created.rev }) as { rev: number };
  const added = (await terminalLivenessEvents(observer)).flatMap(event => parseOutboxEvent(event));
  expect(added).toEqual([]);
  expect(JSON.parse(readFileSync(join(terminalDirectory(ctx, created.id), "published.json"), "utf8"))).toMatchObject({ rev: renamed.rev });
  await callOp(ctx, "terminal.close", { id: created.id, expect_rev: renamed.rev });
  expect(await pushed(observer)).toEqual([]);
});

test("a failed publish leaves the marker untouched and is retried on the next check", async () => {
  const ctx = fakeCtx({ env: { ...process.env } });
  const created = await createTerminal(ctx, { requestId: "retry-shell", kind: "shell", cwd: ctx.home }, { start: () => ({ pid: 99999999 }) });
  const dir = terminalDirectory(ctx, created.id);
  writeFileSync(join(dir, "exit"), "3");
  const marker = join(dir, "published.json"), before = readFileSync(marker, "utf8");
  const failed = await terminalLivenessEvents(ctx, { publish: async () => ({ seq: 0, transports: [], errors: ["outbox down"] }) });
  expect(failed).toEqual([]);
  expect(readFileSync(marker, "utf8")).toBe(before);
  const events = await terminalLivenessEvents(ctx);
  expect(events).toEqual([{ type: "entity", data: { kind: "terminal", id: created.id, value: expect.objectContaining({ live: false, exit: 3 }) } }]);
  expect(await terminalLivenessEvents(ctx)).toEqual([]);
});

test("the liveness check spawns no ps when no terminal has a live pid", async () => {
  const ctx = fakeCtx({ env: { ...process.env } });
  await createTerminal(ctx, { requestId: "dead-shell", kind: "shell", cwd: ctx.home }, { start: () => ({ pid: 99999999 }) });
  const original = Bun.spawnSync;
  let ps = 0;
  (Bun as any).spawnSync = (argv: string[], ...rest: any[]) => { if (argv?.[0] === "ps") ps++; return (original as any)(argv, ...rest); };
  try {
    expect(await terminalLivenessEvents(ctx)).toEqual([]);
    expect(ps).toBe(0);
  } finally { (Bun as any).spawnSync = original; }
});

test("terminal operations reject argv and executor-role callers", async () => {
  const ctx = fakeCtx({ env: { ...process.env, PACER_ROLE: "executor" } });
  await expect(callOp(ctx, "terminal.create", { request_id: "executor-shell", kind: "shell", cwd: ctx.home })).rejects.toMatchObject({ code: "not_allowed" });
  await expect(callOp(ctx, "terminal.list", {})).rejects.toMatchObject({ code: "not_allowed" });
  const planner = fakeCtx({ env: { ...process.env } });
  await expect(callOp(planner, "terminal.create", { request_id: "bad-command", kind: "shell", argv: ["sh", "-c", "touch bad"] })).rejects.toMatchObject({ code: "invalid_input" });
});

test.skipIf(!canBind)("terminal stream requires auth and same-origin cookie", async () => {
  const ctx = fakeCtx({ env: { ...process.env } });
  const created = await callOp(ctx, "terminal.create", { request_id: "ws-shell", kind: "shell", cwd: ctx.home }) as { id: string; rev: number };
  const server = startServer(() => ctx, { port: 0, pumpMs: 3600000 });
  const url = `http://127.0.0.1:${server.port}/v3/terminals/${created.id}/session`;
  try {
    expect((await fetch(url)).status).toBe(401);
    const cookie = `pacer_session=${createSession(ctx)}`;
    expect((await fetch(url, { headers: { cookie } })).status).toBe(403);
    expect((await fetch(url, { headers: { cookie, origin: "http://evil.example" } })).status).toBe(403);
    expect((await fetch(url, { headers: { cookie, origin: new URL(url).origin, "sec-fetch-site": "cross-site" } })).status).toBe(403);
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      if ((await fetch(url, { headers: { authorization: `Bearer ${server.token}` } })).status === 426) { ready = true; break; }
      await Bun.sleep(50);
    }
    expect(ready).toBe(true);
    const ws = new WebSocket(url.replace("http:", "ws:"), { headers: { cookie, origin: new URL(url).origin, "sec-fetch-site": "same-origin" } } as any);
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = reject; });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  } finally {
    await callOp(ctx, "terminal.close", { id: created.id, expect_rev: created.rev });
    await server.stop();
  }
});

test.skipIf(!canBind)("terminal stream refuses an executor bearer even for an existing shell", async () => {
  const owner = fakeCtx({ env: { ...process.env } });
  const created = await callOp(owner, "terminal.create", { request_id: "owned-shell", kind: "shell", cwd: owner.home }) as { id: string; rev: number };
  const executor = { ...owner, env: { ...owner.env, PACER_ROLE: "executor" } };
  const server = startServer(() => executor, { port: 0, pumpMs: 3600000 });
  try {
    const url = `http://127.0.0.1:${server.port}/v3/terminals/${created.id}/session`;
    expect((await fetch(url, { headers: { authorization: `Bearer ${server.token}` } })).status).toBe(403);
  } finally {
    await callOp(owner, "terminal.close", { id: created.id, expect_rev: created.rev });
    await server.stop();
  }
});

test.skipIf(!canBind)("ended terminal stream replays bytes and refuses control or resize",async()=>{
  const ctx=fakeCtx({env:{...process.env}});
  const terminal=await createTerminal(ctx,{requestId:"terminal-replay",kind:"action",title:"Replay",argv:["true"]},{start:()=>({pid:99999999})});
  const dir=terminalDirectory(ctx,terminal.id),recording=new Recording(dir);
  await recording.output(Buffer.from("prefix"));recording.checkpoint();
  await recording.output(Buffer.from([0,255,27,65]));await recording.close();
  writeFileSync(join(dir,"exit"),"7");
  const server=startServer(()=>ctx,{port:0,pumpMs:3600000});
  const url=`ws://127.0.0.1:${server.port}/v3/terminals/${terminal.id}/session`;
  const ws=new WebSocket(url,{headers:{authorization:`Bearer ${server.token}`}} as any);
  ws.binaryType="arraybuffer";
  const frames:({type:string;[key:string]:any})[]=[];
  try{
    await new Promise<void>((resolve,reject)=>{ws.onmessage=e=>{if(typeof e.data==="string")frames.push(JSON.parse(e.data));else for(const frame of new WireDecoder().push(Buffer.from(e.data)))frames.push({type:"output",data:frame.data});};ws.onopen=()=>{ws.send(JSON.stringify({type:"take",force:true}));ws.send(JSON.stringify({type:"size",cols:10,rows:10}));ws.send(new Uint8Array(wire(FrameType.input,Buffer.from("no"))));ws.send(JSON.stringify({type:"hello",v:1,client:"app"}));};ws.onerror=reject;ws.onclose=()=>resolve();});
    expect(frames.find(frame=>frame.type==="snapshot")).toMatchObject({screenAnsi:"prefix",cols:120,rows:40});
    expect(Buffer.concat(frames.filter(frame=>frame.type==="output").map(frame=>frame.data))).toEqual(Buffer.from([0,255,27,65]));
    expect(frames.filter(frame=>frame.type==="control")).toEqual(Array(3).fill({type:"control",controller:null,you:false,reason:"read-only"}));
    expect(frames.find(frame=>frame.type==="exit")).toEqual({type:"exit",code:7,at:expect.any(Number)});
  }finally{ws.close();await server.stop();}
});
