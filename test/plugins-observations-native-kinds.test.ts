import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installFixture } from "../conformance/install";
import { callOp } from "../src/api/ops";
import { editStrategy } from "../src/config/edit";
import { taskData } from "../src/link/pump";
import { publish } from "../src/link/publish";
import { pluginNativeRequest } from "../src/serve/plugin-native";
import { createTask } from "../src/tasks/store";
import { fakeCtx } from "./helpers";
import { makeHome, type Home } from "./native-plugin-door";

// Core's private observation kinds (ADR 0027, observation addendum): what an owner lane's
// generation may read, re-checked against the registry on every request.

const RETIRED = "event generation or projection unavailable";
let home: Home | undefined;
afterEach(() => { home?.done(); home = undefined; });

async function setup() {
  const h = home = makeHome();
  const plugins = join(h.state, "plugins");
  installFixture("observations", plugins);
  installFixture("observations", plugins, { manifest: { id: "fx-unobserved", capabilities: [{ name: "tasks.read" }, { name: "log" }, { name: "config.get" }] } });
  const env = { PATH: process.env.PATH! };
  const off = fakeCtx({ home: h.home, pacerHome: h.state, env });
  const on = fakeCtx({ home: h.home, pacerHome: h.state, env: { ...env, PACER_HOST_SOCKET: join(h.state, "run", "s0123456789ab.sock") } });
  const attached = fakeCtx({ home: h.home, pacerHome: h.state, env: { ...env, PACER_HOST_SOCKET: join(h.state, "run", "host.sock") } });
  for (const id of ["fx-observations", "fx-unobserved"]) await callOp(off, "plugin.enable", { id, grant: true });
  const generation = async (id: string) => ((await pluginNativeRequest(on, { kind: "call_authority", id, method: "diagnostic.ping" })) as any).value.observation.generation as string;
  const ask = (ctx: typeof on, body: Record<string, unknown>, relay = false) => pluginNativeRequest(ctx, body, { relay }) as Promise<any>;
  return { h, off, on, attached, generation, ask };
}

test("observation kinds answer only the native owner of the door that owns the plugin", async () => {
  const { off, on, attached, generation, ask } = await setup();
  const name = await generation("fx-observations");
  expect(name).toMatch(/^[0-9a-f]{64}$/);
  const body = { kind: "observation_events", id: "fx-observations", generation: name, since: null, types: ["task"] };
  const refused = { code: "plugin_unavailable", message: "observations are served to the native owner of the door that owns the plugin" };
  expect((await ask(off, body)).error).toMatchObject(refused);
  expect((await ask(attached, body, true)).error).toMatchObject(refused);
  expect((await ask(on, body)).error).toBeUndefined();
  for (const bad of [{ ...body, generation: "x" }, { ...body, types: [] }, { ...body, types: ["secrets"] }, { ...body, since: -1 }, { ...body, extra: 1 },
    { kind: "observation_retired", id: "fx-observations", generation: name, reason: "anything" },
    { kind: "observation_read", id: "fx-observations", generation: name, method: "capability.fs.read", params: {} }]) {
    expect((await ask(on, bad)).error, JSON.stringify(bad)).toMatchObject({ code: "invalid_input" });
  }
});

test("a new generation starts at the outbox end and gets only its types, in order", async () => {
  const { h, on, generation, ask } = await setup();
  const name = await generation("fx-observations");
  const ctx = fakeCtx({ home: h.home, pacerHome: h.state });
  const task = () => ({ type: "task" as const, data: taskData(createTask(ctx, { brief: { goal: "observed", repo: h.home }, kind: null, requestedExecutor: null, timeoutS: 60 })) });
  expect((await publish(ctx, [task()])).errors).toEqual([]);
  const start = (await ask(on, { kind: "observation_events", id: "fx-observations", generation: name, since: null, types: ["reset"] })).value;
  expect(Object.keys(start)).toEqual(["last"]);
  const [first, second] = [task(), task()];
  expect((await publish(ctx, [first, { type: "mode", data: { mode: "normal", previous: null, strategy: "default", at: ctx.now } }, second])).errors).toEqual([]);
  const batch = (await ask(on, { kind: "observation_events", id: "fx-observations", generation: name, since: start.last, types: ["task"] })).value;
  expect(batch.events.map((e: any) => [e.seq - start.last, e.type, e.data.id])).toEqual([[1, "task", first.data.id], [3, "task", second.data.id]]);
  expect(batch.last).toBe(start.last + 3);
  expect(batch.reset).toBe(false);
});

test("a stale, ungranted or undeclared generation reads nothing", async () => {
  const { h, on, generation, ask } = await setup();
  const name = await generation("fx-observations");
  const ctx = fakeCtx({ home: h.home, pacerHome: h.state });
  const id = createTask(ctx, { brief: { goal: "read me", repo: h.home }, kind: null, requestedExecutor: null, timeoutS: 60 }).id;
  const read = (generation: string) => ask(on, { kind: "observation_read", id: "fx-observations", generation, method: "capability.tasks.read", params: { id } });
  expect((await read(name)).value.task).toMatchObject({ id, state: "queued" });
  const denied = { code: "capability_denied", message: "read owner generation changed" };
  expect((await read("0".repeat(64))).error).toMatchObject(denied);
  // The plugin's config is part of its observation fingerprint: the old generation retires.
  expect(editStrategy(join(h.state, "strategy.yaml"), doc => doc.setIn(["plugins", "config", "fx-observations"], { types: ["activity"] })).ok).toBe(true);
  expect((await read(name)).error).toMatchObject(denied);
  expect((await ask(on, { kind: "observation_events", id: "fx-observations", generation: name, since: null, types: ["task"] })).error).toMatchObject(denied);
  const fresh = await generation("fx-observations");
  expect(fresh).not.toBe(name);
  expect((await read(fresh)).error).toBeUndefined();
  // Disabled: no generation reads.
  await callOp(ctx, "plugin.disable", { id: "fx-observations" });
  expect((await read(fresh)).error).toMatchObject(denied);
  // A plugin that never declared events.subscribe has no subscription to feed.
  const events = await ask(on, { kind: "observation_events", id: "fx-unobserved", generation: await generation("fx-unobserved"), since: null, types: ["task"] });
  expect(events.error).toMatchObject({ code: "capability_denied", message: "read owner cannot authorize this capability" });
});

test("a retirement the owner reports marks the plugin failing, once and only for the live generation", async () => {
  const { h, on, generation, ask } = await setup();
  const name = await generation("fx-observations");
  const retire = (generation: string) => ask(on, { kind: "observation_retired", id: "fx-observations", generation, reason: RETIRED });
  const state = async () => ((await callOp(fakeCtx({ home: h.home, pacerHome: h.state }), "plugin.list", {})) as any).plugins.find((p: any) => p.id === "fx-observations");
  expect((await retire("0".repeat(64))).error).toBeUndefined();
  expect(await state()).toMatchObject({ state: "idle" });
  expect((await retire(name)).error).toBeUndefined();
  expect(await state()).toMatchObject({ state: "failing", error: RETIRED });
  const log = readFileSync(join(h.state, "logs", "plugins", "fx-observations.log"), "utf8");
  expect(log.trim().split("\n").map(line => line.replace(/^\S+ /, ""))).toEqual([`[observation] ${RETIRED}`]);
});
