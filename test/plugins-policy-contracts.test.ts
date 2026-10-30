import { expect, test } from "bun:test";
import { parsePlugins } from "../src/config/strategy";
import { ACTIVITY_KINDS } from "../src/activity/types";
import {
  CAPABILITY_METHODS,
  EXTENSION_METHODS,
  PLUGIN_PROTOCOL_VERSION,
  callMetadata,
  pluginMetadata,
  manifestSchema,
} from "../src/plugins/protocol";

test("policy config defaults open and rejects malformed policy instead of silently opening", () => {
  for (const raw of [
    undefined,
    {},
    { policy: {} },
    { policy: { mode: "open" } },
  ]) {
    const errors: string[] = [];
    expect(parsePlugins(raw, errors).policy).toEqual({ mode: "open" });
    expect(errors).toEqual([]);
  }
  const errors: string[] = [];
  expect(parsePlugins({ policy: { mode: "closed" } }, errors).policy).toEqual({
    mode: "closed",
  });
  for (const policy of [null, [], "closed", { mode: 3 }, { mode: "maybe" }]) {
    const errors: string[] = [];
    parsePlugins({ policy }, errors);
    expect(errors.length).toBeGreaterThan(0);
  }
});
test("policy contracts expose bounded decision-specific amendments and policy activity", () => {
  expect(PLUGIN_PROTOCOL_VERSION).toBe("1.6.0");
  expect(ACTIVITY_KINDS).toContain("policy");
  expect(
    manifestSchema.safeParse({
      id: "fx-policy",
      version: "1.0.0",
      publisher: "test",
      host: "^1.6",
      contributes: { policy: {} },
    }).success,
  ).toBe(true);
  const method = EXTENSION_METHODS["policy.before"];
  expect(method).toBeDefined();
  expect(method.deadlineMs).toBe(3000);
  expect(
    method.params.safeParse({
      decision: "delegate",
      input: {
        goal: "g",
        repo: "/tmp/r",
        kind: null,
        requestedExecutor: null,
        placement: "auto",
      },
    }).success,
  ).toBe(true);
  expect(
    method.params.safeParse({
      decision: "review",
      input: { taskId: "t", revision: 1, state: "done", verdict: "accept" },
    }).success,
  ).toBe(true);
  expect(
    method.result.safeParse({
      verdict: "amend",
      amend: { requestedExecutor: "codex", placement: "new" },
    }).success,
  ).toBe(true);
  for (const result of [
    { verdict: "amend", amend: { goal: "replace" } },
    { verdict: "amend", amend: { exclude: [3] } },
    { verdict: "veto", reason: "x".repeat(513) },
  ])
    expect(method.result.safeParse(result).success).toBe(false);
});
test("task and event capability schemas are bounded and do not duplicate capability names", () => {
  expect(
    CAPABILITY_METHODS["capability.tasks.list"].params.safeParse({
      states: ["running"],
      limit: 500,
    }).success,
  ).toBe(true);
  for (const p of [{ limit: 501 }, { states: ["fake"] }])
    expect(
      CAPABILITY_METHODS["capability.tasks.list"].params.safeParse(p).success,
    ).toBe(false);
  expect(
    CAPABILITY_METHODS["capability.events.subscribe"].params.safeParse({
      types: ["task"],
    }).success,
  ).toBe(true);
  for (const p of [{ types: [] }, { types: ["budget"] }, { types: ["fake"] }])
    expect(
      CAPABILITY_METHODS["capability.events.subscribe"].params.safeParse(p)
        .success,
    ).toBe(false);
});
test("readOwner is an exclusive metadata arm while old optional correlation remains compatible", () => {
  expect(callMetadata.safeParse(undefined).success).toBe(true);
  expect(
    callMetadata.safeParse({ capabilityCall: "call", future: true }).success,
  ).toBe(true);
  expect(
    pluginMetadata.safeParse({ readOwner: "read", future: true }).success,
  ).toBe(true);
  for (const m of [
    {},
    { readOwner: "" },
    { readOwner: "x".repeat(257) },
    { readOwner: "read", capabilityCall: "call" },
  ])
    expect(pluginMetadata.safeParse(m).success).toBe(false);
});

test("foreign read owners never fall back to unowned capability handling", async () => {
  const { PluginProcess } = await import("../src/plugins/process");
  const replies: any[] = [];
  let calls = 0;
  const process = Object.create(PluginProcess.prototype) as any;
  process.pending = new Map();
  process.features = [];
  process.send = (m: unknown) => replies.push(m);
  process.hooks = {
    onRequest: () => {
      calls++;
      return {};
    },
  };
  for (const _meta of [
    { readOwner: "unknown" },
    { capabilityCall: "call", readOwner: "unknown" },
    {},
  ])
    process.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "capability.config.get",
        params: {},
        _meta,
      }),
    );
  expect(calls).toBe(0);
  expect(replies).toHaveLength(3);
  for (const reply of replies)
    expect(reply.error.data.code).toBe("capability_denied");
});

test("older peers cannot use unnegotiated observation helpers or send requests", async () => {
  const { serve } = await import("@pacer/plugin");
  const writes: any[] = [];
  async function* input() {
    yield JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "plugin.hello",
      params: { protocol: "1.0.0", config: {}, grants: [] },
    });
    yield JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "diagnostic.ping",
      params: {},
    });
  }
  await serve({
    manifest: { id: "fx", version: "1.0.0", publisher: "t", host: "^1" },
    input: input(),
    write: (l) => writes.push(JSON.parse(l)),
    handlers: {
      "diagnostic.ping": async (_p, host) => {
        for (const fn of [
          () => host.tasks.read("t"),
          () => host.tasks.list(),
          () => host.events.subscribe(["task"]),
        ])
          await expect(fn()).rejects.toMatchObject({
            code: "plugin_unavailable",
          });
        return { ok: true, uptimeS: 0 };
      },
    },
  });
  expect(writes.some((m) => m.method?.startsWith("capability."))).toBe(false);
  expect(writes[0].result.protocol).toBe("1.6.0");
});

test("older peers cannot bootstrap callbacks and unowned direct brokers still deny", async () => {
  const { serve } = await import("@pacer/plugin");
  const writes:any[]=[];
  async function* oldInput(){
    yield JSON.stringify({jsonrpc:"2.0",id:1,method:"plugin.hello",params:{protocol:"1.4.0",config:{},grants:[]}});
    yield JSON.stringify({jsonrpc:"2.0",id:2,method:"diagnostic.ping",params:{},_meta:{capabilityCall:"actual-call"}});
  }
  await serve({manifest:{id:"fx",version:"1.0.0",publisher:"t",host:"^1"},onEvent:()=>{},input:oldInput(),write:line=>writes.push(JSON.parse(line))});
  expect(writes.find(reply=>reply.id===2)).toMatchObject({error:{data:{code:"plugin_unavailable"}}});
  expect(writes.some(reply=>reply.method?.startsWith("capability."))).toBe(false);
  const { answerCapability } = await import("../src/plugins/host");
  const { fakeCtx } = await import("./helpers");
  const plugin = {
    id: "fx-policy",
    manifest: manifestSchema.parse({
      id: "fx-policy",
      version: "1.0.0",
      publisher: "t",
      host: "^1",
      capabilities: [{ name: "tasks.read" }, { name: "events.subscribe" }],
    }),
  };
  for (const [method, params] of [
    ["capability.tasks.read", { id: "t" }],
    ["capability.tasks.list", {}],
    ["capability.events.subscribe", { types: ["task"] }],
  ] as const)
    await expect(
      answerCapability(fakeCtx(), plugin, method, params),
    ).rejects.toMatchObject({ code: "capability_denied" });
});

test("full metadata envelope remains exclusive for chunks and negotiates implemented observations", async () => {
  const { PluginProcess } = await import("../src/plugins/process");
  const process = Object.create(PluginProcess.prototype) as any;
  process.pending = new Map();
  process.features = [];
  for (const meta of [
    { readOwner: "unknown" },
    { readOwner: "unknown", capabilityCall: "known" },
  ])
    await expect(
      process.stageResult({ request: 1, offset: 0, base64: "" }, meta, () => {
        throw Error("unexpected chunk delivery");
      }),
    ).rejects.toMatchObject({ name: "CoreError" });
  const { serve } = await import("@pacer/plugin");
  const out: any[] = [];
  async function* input() {
    yield JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "plugin.hello",
      params: {
        protocol: "1.6.0",
        features: ["policyObservations", "chunkedResults"],
        config: {},
        grants: [],
      },
    });
  }
  await serve({
    manifest: { id: "fx", version: "1.0.0", publisher: "t", host: "^1" },
    input: input(),
    write: (l) => out.push(JSON.parse(l)),
  });
  expect(out[0].result.features).toEqual(["policyObservations", "chunkedResults"]);
});

test("observation event names match the current public v3 hello contract", async () => {
  const { helloBody } = await import("../src/api/protocol");
  const { POLICY_EVENT_TYPES } = await import("../src/plugins/policy-protocol");
  const names: string[] = [...POLICY_EVENT_TYPES];
  expect(names.sort()).toEqual(helloBody().events.sort());
});

test("route contracts do not invent a configured runner count ceiling", () => {
  const candidates = Array.from({ length: 1025 }, (_, i) => `runner-${i}`);
  const method = EXTENSION_METHODS["policy.before"];
  expect(
    method.params.safeParse({
      decision: "route",
      input: { taskId: "t", candidates },
    }).success,
  ).toBe(true);
  expect(
    method.result.safeParse({
      verdict: "amend",
      amend: { exclude: candidates },
    }).success,
  ).toBe(true);
});

test("opposing reserved key presence is forbidden even when its token is invalid", async () => {
  for (const opposite of ["owner", "", 3, null, {}]) {
    expect(
      pluginMetadata.safeParse({ capabilityCall: "call", readOwner: opposite })
        .success,
    ).toBe(false);
    expect(
      pluginMetadata.safeParse({ capabilityCall: opposite, readOwner: "owner" })
        .success,
    ).toBe(false);
  }
  expect(pluginMetadata.safeParse(undefined).success).toBe(true);
  for (const value of [
    { capabilityCall: "call", future: true },
    { readOwner: "owner", future: true },
  ])
    expect(pluginMetadata.parse(value)).toEqual(value);
  const { pluginProtocolSchema } = await import(
    "../scripts/plugin-protocol-doc"
  );
  const schema = pluginProtocolSchema() as any;
  for (const [index, key] of [
    [0, "readOwner"],
    [1, "capabilityCall"],
  ] as const)
    expect(schema.$defs.pluginMetadata.oneOf[index].properties[key]).toEqual({
      not: {},
    });
});
