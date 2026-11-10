import {expect, test} from "bun:test";
import {mkdirSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {callOp, OPS} from "../src/api/ops";
import {fakeCtx} from "./helpers";

function setup(models = "{id: m1, context: 8192, output: 512, tools: true}, {id: m2, context: 4096, output: 512, tools: false}") {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, {recursive: true});
  const connection = `{api: openai-compatible, base_url: "http://127.0.0.1:9", key: none, models: [${models}]}`;
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), `planner: codex
accounts:
  codex: {kind: codex}
  ep: {kind: endpoint, connection: ${connection}}
runners:
  opencode#ep: {}
`);
  return ctx;
}

test("executor.models.available returns the runner's list", async () => {
  const ctx = setup();
  const body = await callOp(ctx, "executor.models.available", {runner: "opencode#ep"}) as {runner: string; source: string; models: {id: string}[] | null};
  expect(body).toMatchObject({runner: "opencode#ep", source: "connection"});
  expect(body.models?.map(m => m.id)).toEqual(["pacer-ep/m1", "pacer-ep/m2"]);
});

test("unknown runner is invalid_input", async () => {
  const ctx = setup();
  await expect(callOp(ctx, "executor.models.available", {runner: "nope"})).rejects.toMatchObject({code: "invalid_input", message: "unknown runner nope"});
});

test("the op is registered", () => {
  expect(Object.keys(OPS)).toContain("executor.models.available");
});