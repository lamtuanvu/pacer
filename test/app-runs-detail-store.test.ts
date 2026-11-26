import { expect, test } from "bun:test";
import { initialRunsStore, refreshRunDetail, refreshRunsList } from "../app/src/data/runs";
import { ALL_OPS, apiFor, generated, plain, type Calls } from "./app-run-view-fixtures";

test("refreshRunDetail keeps decisions, graph projections, artifacts, messages and open/answered questions", async () => {
  const calls: Calls = { ops: [] };
  const api = apiFor({ ...plain, questions: [{ ...plain.questions![0]!, status: "answered", answer: "approve" }] }, calls);
  const next = await refreshRunDetail(api, initialRunsStore(), "run_1", new Set(ALL_OPS));
  const d = next.details.run_1!;
  expect(d.decisions).toHaveLength(1);
  expect(d.artifacts).toHaveLength(1);
  expect(d.definition).toBeDefined();
  expect(d.messages?.map(m => m.body)).toEqual(["Keep it small."]);
  expect(d.questions[0]).toMatchObject({ id: "q_spec", status: "answered", answer: "approve", createdAt: 920 });
});

test("msg.log is only read when the service offers it and the run has an orchestrator task", async () => {
  const calls: Calls = { ops: [] };
  const api = apiFor(plain, calls);
  await refreshRunDetail(api, initialRunsStore(), "run_1", new Set(ALL_OPS.filter(o => o !== "msg.log")));
  expect(calls.ops.some(c => c.op === "msg.log")).toBe(false);
});

test("generated child runs are read through parentRunId and failures to read one are skipped", async () => {
  const calls: Calls = { ops: [] };
  const ops = new Set(ALL_OPS);
  const api = apiFor(generated, calls);
  const listed = await refreshRunsList(api, initialRunsStore(), ops);
  const next = await refreshRunDetail(api, listed, "run_1", ops);
  expect(Object.keys(next.details.run_1!.children!)).toEqual(["run_child"]);
  expect(next.details.run_1!.children!.run_child!.steps).toHaveLength(3);

  const failing = apiFor(generated, { ops: [] }, { "run.get": p => { if ((p as { id: string }).id === "run_child") throw new Error("gone"); return generated.get; } });
  const again = await refreshRunDetail(failing, listed, "run_1", ops);
  expect(again.details.run_1!.children).toEqual({});
  expect(again.details.run_1!.error).toBeNull();
});
