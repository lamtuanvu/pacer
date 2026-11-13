import { expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync as realpath, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installFixture } from "../conformance/install";
import { taskData } from "../src/link/pump";
import { publish } from "../src/link/publish";
import { eventsSince } from "../src/api/events";
import type { ApiEvent } from "../src/api/protocol";
import { createTask } from "../src/tasks/store";
import type { Ctx } from "../src/types";
import { alive, front, makeHome, ownerOn, serve, stdio, tsOwner, type Home, type Options } from "./native-plugin-door";

// Policy observations under the native owner (ADR 0027, observation addendum): on the same Rust
// front door, a plugin receives byte-for-byte the `$/event` lines the TypeScript registry writes
// with the owner off, filtered by its grant and configured types, and reads tasks the same way.

const RECORDING_MAIN = `#!/usr/bin/env bun
import {serve,stdinLines,type PluginManifest} from '@pacer/plugin';
import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
writeFileSync(join(import.meta.dir,'pid'),String(process.pid));
const manifest=JSON.parse(readFileSync(join(import.meta.dir,'pacer-plugin.json'),'utf8')) as PluginManifest;
const record=(name:string,line:string)=>appendFileSync(join(import.meta.dir,name),line+'\\n');
async function* recorded(){for await(const line of stdinLines()){if(line.includes('"method":"$/event"'))record('events.jsonl',line);yield line;}}
await serve({manifest,input:recorded(),handlers:{'diagnostic.ping':async(_params,host)=>{
  const config=await host.config();
  try{await host.events.subscribe(config.types as ['task']);}catch(error){record('subscribe.jsonl',JSON.stringify({code:(error as {code?:string}).code,message:(error as Error).message}));}
  return {ok:true,uptimeS:0};
}},onEvent:async(event,host)=>{
  const data=event.data as {id?:string;taskId?:string};const id=event.type==='task'?data.id:data.taskId;if(!id)return;
  const task=await host.tasks.read(id);record('reads.jsonl',JSON.stringify({seq:event.seq,id:task.id,state:task.state}));
}});
`;

const PLUGINS = [
  { id: "fx-observations", types: ["task", "activity"], capabilities: undefined },
  { id: "fx-activity-only", types: ["activity"], capabilities: undefined },
  { id: "fx-unobserved", types: ["task", "activity"], capabilities: [{ name: "tasks.read" }, { name: "log" }, { name: "config.get" }] },
] as const;

/** Outbox time for published events; wall-clock times stay below it until 2033. */
const NOW = 2_000_000_000;

type Door = { call(op: string, params: unknown): Promise<{ json: any }>; stop(): Promise<unknown> };
type Mode = { label: string; options: Options; transport: "stdio" | "http" };
const MODES: Mode[] = [
  { label: "stdio off", options: tsOwner, transport: "stdio" },
  { label: "stdio on", options: ownerOn, transport: "stdio" },
  { label: "serve off", options: tsOwner, transport: "http" },
  { label: "serve on", options: ownerOn, transport: "http" },
];

/** Each task gets its own second, so ids and snapshots sort the same in every home. */
function ctxOf(h: Home, now = NOW): Ctx {
  return { home: h.home, pacerHome: h.state, now, env: { HOME: h.home, PACER_HOME: h.state }, which: () => null, run: async () => { throw Error("the event publisher runs no commands"); } };
}

function prepare(h: Home): string {
  const plugins = join(h.state, "plugins");
  for (const plugin of PLUGINS) {
    const dir = installFixture("observations", plugins, { manifest: { id: plugin.id, ...(plugin.capabilities ? { capabilities: plugin.capabilities } : {}) } });
    writeFileSync(join(dir, "main.ts"), RECORDING_MAIN);
  }
  writeFileSync(join(h.state, "strategy.yaml"), `planner: claude-code\nproviders: {claude-code: {}}\nplugins:\n  config:\n${PLUGINS.map(p => `    ${p.id}:\n      types: [${p.types.join(", ")}]\n`).join("")}`);
  return createTask(ctxOf(h), { brief: { goal: "observation parity", repo: h.home }, kind: null, requestedExecutor: null, timeoutS: 60 }).id;
}

const lines = (h: Home, id: string, name: string) => {
  const path = join(h.state, "plugins", id, name);
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : [];
};

/** Wait until every plugin's recordings stop changing for `quiet` ms. */
async function settled(h: Home, quiet = 1500, limit = 20000) {
  const snapshot = () => JSON.stringify(PLUGINS.map(p => ["events.jsonl", "reads.jsonl", "subscribe.jsonl"].map(name => lines(h, p.id, name))));
  let last = snapshot(), since = Date.now();
  for (const end = Date.now() + limit; Date.now() < end; await Bun.sleep(100)) {
    const now = snapshot();
    if (now !== last) { last = now; since = Date.now(); } else if (Date.now() - since >= quiet && lines(h, PLUGINS[0].id, "reads.jsonl").length >= 3) return;
  }
  throw Error(`recordings did not settle: ${last}`);
}

async function door(h: Home, mode: Mode): Promise<Door> {
  if (mode.transport === "http") return await serve(h, "", mode.options);
  const session = await stdio(h, "", mode.options);
  return { call: (op, params) => session.call(op, params), stop: () => session.stop() };
}

const tasks: string[] = [], seqs: string[] = [];
const rank = (seen: string[], value: string) => (seen.includes(value) ? seen : (seen.push(value), seen)).indexOf(value);
/**
 * Only what differs between two fresh homes: their paths, random task and activity ids, wall-clock
 * times and the absolute outbox position (each door writes its own unrelated events). Seqs become
 * their rank, so order and gaps between delivered events still compare.
 */
function stable(h: Home, line: string): string {
  return line.replaceAll(realpath(h.home), "<HOME>").replaceAll(h.home, "<HOME>")
    .replace(/pnh-[A-Za-z0-9]{6}/g, "<LABEL>").replace(/local:[0-9a-f]{12}/g, "<REPO>")
    .replace(/t-\d{8}-\d{6}-[0-9a-f]{4}/g, id => `<T${rank(tasks, id)}>`)
    .replace(/"machineId":"[a-z0-9]+"/g, '"machineId":"<MACHINE>"')
    .replace(/"id":"\d+\.\d+-[0-9a-f]{4}"/g, '"id":"<ACTIVITY>"')
    .replace(/(?<=":)1\d{9}(\.\d+)?(?=[,}])/g, '"<WALL>"')
    .replace(/"seq":(\d+)/g, (_match, seq: string) => `"seq":"<S${rank(seqs, seq)}>"`);
}

type Recording = { events: Record<string, string[]>; reads: Record<string, string[]>; subscribe: Record<string, string[]>; errors: Record<string, string | null>; pids: number[] };

async function run(mode: Mode): Promise<Recording> {
  const h = makeHome();
  try {
    const taskId = prepare(h);
    const d = await door(h, mode);
    tasks.length = 0; seqs.length = 0;
    let pids: number[] = [];
    const errors: Record<string, string | null> = {};
    try {
      for (const plugin of PLUGINS) expect((await d.call("plugin.enable", { id: plugin.id, grant: true })).json.result.state, plugin.id).not.toBe("needs_grant");
      for (const plugin of PLUGINS) errors[plugin.id] = (await d.call("plugin.doctor", { id: plugin.id })).json.result.reports[0].error;
      pids = PLUGINS.map(p => Number(readFileSync(join(h.state, "plugins", p.id, "pid"), "utf8")));
      const ctx = ctxOf(h);
      let created = 0;
      const task = () => ({ type: "task" as const, data: taskData(createTask(ctxOf(h, NOW + ++created), { brief: { goal: "published", repo: h.home }, kind: null, requestedExecutor: null, timeoutS: 60 })) });
      expect((await publish(ctx, [{ type: "mode", data: { mode: "normal", previous: null, strategy: "default", at: NOW } }, task()])).errors).toEqual([]);
      expect((await d.call("task.stop", { id: taskId })).json.error).toBeUndefined();
      expect((await publish(ctx, [task(), task()])).errors).toEqual([]);
      await settled(h);
      expect(pids.every(alive), `${mode.label}: observing children outlive their bootstrap calls`).toBe(true);
    } finally {
      await d.stop();
    }
    const end = Date.now() + 10000;
    while (Date.now() < end && pids.some(alive)) await Bun.sleep(50);
    expect(pids.filter(alive), `${mode.label}: closing the door retires every observing child`).toEqual([]);
    // Ground truth: from its first delivered event on, each plugin gets every outbox event of its
    // types, in order, as the registry writes it.
    const outbox: ApiEvent[] = [];
    for (let cursor = 0, more = true; more;) {
      const batch = eventsSince(ctxOf(h), cursor, 3);
      outbox.push(...batch.events);
      more = batch.last > cursor && batch.events.length > 0;
      cursor = batch.last;
    }
    for (const plugin of PLUGINS) {
      const delivered = lines(h, plugin.id, "events.jsonl"), first = delivered.length ? JSON.parse(delivered[0]!).params.seq : Infinity;
      const expected = outbox.filter(event => event.seq >= first && (event.type === "reset" || (plugin.types as readonly string[]).includes(event.type)));
      expect(delivered, `${mode.label} ${plugin.id} gets its outbox events`).toEqual(expected.map(event => JSON.stringify({ jsonrpc: "2.0", method: "$/event", params: event })));
    }
    const each = (name: string) => Object.fromEntries(PLUGINS.map(p => [p.id, lines(h, p.id, name).map(line => stable(h, line))]));
    return { events: each("events.jsonl"), reads: each("reads.jsonl"), subscribe: each("subscribe.jsonl"), errors, pids };
  } finally {
    h.done();
  }
}

const recordings = new Map<string, Recording>();
const maybe = front ? test : test.skip;

for (const mode of MODES) {
  maybe(`${mode.label}: grant- and type-filtered events reach observing plugins`, async () => {
    const recording = await run(mode);
    recordings.set(mode.label, recording);
    const types = (id: string) => [...new Set(recording.events[id]!.map(line => JSON.parse(line).params.type))].sort();
    expect(types("fx-observations")).toEqual(["activity", "task"]);
    expect(recording.events["fx-observations"]!.filter(line => line.includes('"title":"published"')).length, "every published task reaches the observer").toBeGreaterThanOrEqual(3);
    expect(types("fx-activity-only")).toEqual(["activity"]);
    expect(recording.events["fx-unobserved"]).toEqual([]);
    expect(recording.reads["fx-unobserved"]).toEqual([]);
    expect(recording.subscribe["fx-unobserved"]!.map(line => JSON.parse(line).code)).toEqual(["capability_denied"]);
    expect(recording.errors).toEqual({ "fx-observations": null, "fx-activity-only": null, "fx-unobserved": "capability_denied: plugin fx-unobserved did not declare events.subscribe" });
  }, 120000);
}

// A serve also publishes its own task snapshots as it notices changes, so only the stdio doors'
// outboxes match event for event; each serve is held to its own outbox above.
for (const label of ["stdio on"]) {
  maybe(`${label}: every plugin receives byte-identical events and reads to the TypeScript owner`, () => {
    const off = recordings.get(label.replace(" on", " off")), on = recordings.get(label);
    expect(off && on, "both recordings ran").toBeTruthy();
    expect(on!.events).toEqual(off!.events);
    expect(on!.reads).toEqual(off!.reads);
    expect(on!.subscribe).toEqual(off!.subscribe);
    expect(on!.errors).toEqual(off!.errors);
  });
}
