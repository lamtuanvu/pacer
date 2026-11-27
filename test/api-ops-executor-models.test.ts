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
test("executor.models.available lists Cursor from cursor-agent models; runner.set still checks nothing for it", async () => {
  const argvs: string[][] = [];
  const ctx = fakeCtx({run: async argv => { argvs.push(argv); return {code: 0, stdout: "Available models\n\nauto - Auto (current, default)\ngpt-5.3-codex - Codex 5.3\n", stderr: ""}; }});
  mkdirSync(ctx.pacerHome, {recursive: true});
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: codex\naccounts:\n  codex: {kind: codex}\n  cursor: {kind: cursor}\nrunners:\n  cursor: {}\n");
  const body = await callOp(ctx, "executor.models.available", {runner: "cursor"});
  expect(body).toEqual({runner: "cursor", source: "cursor", models: [{id: "auto", name: "Auto"}, {id: "gpt-5.3-codex", name: "Codex 5.3"}], fetchedAt: ctx.now, provider: "cursor"});
  expect(argvs).toEqual([["cursor-agent", "models"]]);
  // A model the list does not show is still accepted: the agent's list only feeds the pick list.
  expect(await callOp(ctx, "runner.set", {id: "cursor", model: "not-listed"})).not.toHaveProperty("warnings", expect.arrayContaining([expect.stringContaining("not-listed")]));
  expect(argvs).toHaveLength(1);
});
