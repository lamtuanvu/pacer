import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseDelegateBrief, validateInput } from "../src/tasks/api";
import { queueCapacity } from "../src/tasks/capacity";
import { validateStrategy } from "../src/config/strategy";
import { queueStrategy } from "./queue-helpers";
import { fakeCtx } from "./helpers";
import { slotLimit, slotUse } from "../src/engine/slots";
import { setMachineReaders } from "../src/engine/machine";
import { capacityFixture } from "./read-model-helpers";
import type { Strategy } from "../src/config/strategy";
import type { TaskRecord } from "../src/tasks/types";

interface Golden {
  id: string;
  raw: Record<string, unknown>;
  brief?: Record<string, unknown>;
  input?: Record<string, unknown>;
  error?: string;
}
// The preload pins these readers; restoring the system readers would leak host load into later files.
const restoreReaders = () => setMachineReaders({pressure: () => 1, load: () => ({avg1: 0, cores: 1})});
const goldens = JSON.parse(readFileSync(new URL("./fixtures/task-admission/brief-goldens.json", import.meta.url), "utf8")) as Golden[];
const strategy = validateStrategy({ planner: "claude-code", providers: { "claude-code": {}, codex: {} } }, "test");

for (const golden of goldens) test(`delegate brief golden: ${golden.id}`, () => {
  const ctx = fakeCtx();
  const raw = { ...golden.raw, repo: golden.raw.repo === "$REPO" ? ctx.home : golden.raw.repo };
  if (Object.hasOwn(golden, "error")) {
    expect(() => parseDelegateBrief(raw, ctx.home)).toThrow(golden.error);
    return;
  }
  const parsed = parseDelegateBrief(raw, ctx.home);
  expect(JSON.parse(JSON.stringify(parsed.brief))).toEqual({ ...golden.brief, repo: ctx.home });
  const { brief: _brief, ...input } = JSON.parse(JSON.stringify(parsed));
  expect(input).toEqual(golden.input ?? {});
  expect(validateInput(strategy, parsed)).toEqual([]);
});

const slotGoldens = JSON.parse(readFileSync(new URL("./fixtures/task-admission/slot-goldens.json", import.meta.url), "utf8")) as Array<{id:string;tasks:unknown[];expected:unknown}>;
for (const row of slotGoldens) test(`slot use golden: ${row.id}`, () => {
  expect(slotUse(row.tasks as TaskRecord[])).toEqual(row.expected as ReturnType<typeof slotUse>);
});

const slotLimitGoldens = JSON.parse(readFileSync(new URL("./fixtures/task-admission/slot-limit-goldens.json", import.meta.url), "utf8")) as Array<{
  id: string; strategy: Strategy; runnerId: string; expected: ReturnType<typeof slotLimit>;
}>;
for (const row of slotLimitGoldens) test(`slot limit golden: ${row.id}`, () => {
  expect(slotLimit(row.strategy, row.runnerId)).toEqual(row.expected);
});

const strategyCapacityGoldens = JSON.parse(readFileSync(new URL("./fixtures/task-admission/strategy-capacity-goldens.json", import.meta.url), "utf8")) as Array<{
  id: string; strategy: Strategy; executor: string;
  use: { byExecutor: Record<string, number>; byHost: Record<string, number>; local: number };
  guard?: {reason: "machine_memory_pressure" | "machine_load"; detail: string; machine: {memoryPressure?: string; memoryPressureLimit?: string}};
  expected: NonNullable<ReturnType<typeof queueCapacity>> | null;
}>;
for (const row of strategyCapacityGoldens) test(`strategy capacity golden: ${row.id}`, () => {
  const s = row.strategy;
  const resolved = s.runners[row.executor]
    ?? (s.runnerAliases?.[row.executor] ? s.runners[s.runnerAliases[row.executor]] : undefined);
  const originalPressure = s.execution.local_memory_pressure_limit;
  try {
    // Rust queue_capacity_for takes a precomputed guard; TypeScript derives it from signals.
    if (row.guard && !resolved?.host) {
      s.execution.local_memory_pressure_limit = row.guard.machine.memoryPressureLimit ?? "critical";
      setMachineReaders({
        pressure: () => row.guard!.machine.memoryPressure === "warning" ? 2 : 4,
        load: () => null,
      });
    } else setMachineReaders({ pressure: () => null, load: () => null });
    expect(queueCapacity(s, row.executor, row.use) ?? null).toEqual(row.expected);
  } finally {
    s.execution.local_memory_pressure_limit = originalPressure;
    restoreReaders();
  }
});

const capacityBranches = JSON.parse(readFileSync(new URL("./fixtures/task-admission/capacity-branches.json", import.meta.url), "utf8")) as Array<{id:string;executor:string;limits:{executor:number;host:number|null;local:number|null};use:{byExecutor:Record<string,number>;byHost:Record<string,number>;local:number};expected:unknown}>;
for (const row of capacityBranches) test(`capacity branch golden: ${row.id}`, () => {
  const {s} = capacityFixture();
  s.runners[row.executor]!.maxTasks = row.limits.executor;
  s.hosts.devbox!.maxTasks = row.limits.host ?? 3;
  s.execution.local_max_tasks = row.limits.local;
  if (row.id === "memory-guard") {
    s.execution.local_memory_pressure_limit = "warning";
    setMachineReaders({pressure: () => 2, load: () => null});
  } else setMachineReaders({pressure: () => null, load: () => null});
  try { expect(queueCapacity(s, row.executor, row.use) ?? null).toEqual(row.expected as Exclude<ReturnType<typeof queueCapacity>, undefined> | null); }
  finally { restoreReaders(); }
});

const validationGoldens = JSON.parse(readFileSync(new URL("./fixtures/task-admission/validation-goldens.json", import.meta.url), "utf8")) as Array<{id:string;input:unknown;problems:string[]}>;
for (const row of validationGoldens) test(`direct validation golden: ${row.id}`, () => {
  expect(validateInput(strategy, row.input as Parameters<typeof validateInput>[1])).toEqual(row.problems);
});

test("brief parser accepts default repository without copying internal admission fields", () => {
  const ctx = fakeCtx();
  const parsed = parseDelegateBrief({ goal: "work", admissionLease: "untrusted", workGrant: "untrusted" }, ctx.home);
  expect(parsed.brief.repo).toBe(ctx.home);
  expect(parsed).not.toHaveProperty("admissionLease");
  expect(parsed).not.toHaveProperty("workGrant");
});

test("brief parser rejects an empty default repository", () => {
  expect(() => parseDelegateBrief({goal: "work"}, "")).toThrow("repo");
});

for (const file of ["trim-goldens.json", "numeric-goldens.json", "string-length-goldens.json"]) {
  const rows = JSON.parse(readFileSync(new URL(`./fixtures/task-admission/${file}`, import.meta.url), "utf8")) as Array<{id:string;raw?:Record<string,unknown>;input?:unknown;accept:boolean;title?:string;outputPath?:(string|number)[];expectedValue?:number}>;
  for (const row of rows) test(`${file}: ${row.id}`, () => {
    const ctx = fakeCtx();
    if (row.raw) {
      if (!row.accept) expect(() => parseDelegateBrief(row.raw, ctx.home)).toThrow();
      else {
        const parsed = parseDelegateBrief(row.raw, ctx.home);
        if (row.title !== undefined) expect(parsed.title).toBe(row.title);
        if (row.outputPath) {
          let selected: unknown = parsed;
          for (const part of row.outputPath[0] === "input" ? row.outputPath.slice(1) : row.outputPath) selected = (selected as Record<string | number, unknown>)[part];
          expect(selected).toBe(row.expectedValue);
        }
      }
    }
    if (row.input) expect(validateInput(strategy, row.input as Parameters<typeof validateInput>[1]).length === 0).toBe(row.accept);
  });
}

test("queue capacity goldens preserve executor-slot isolation", () => {
  const cases = JSON.parse(readFileSync(new URL("./fixtures/task-admission/capacity-goldens.json", import.meta.url), "utf8")) as Array<{
    id: string;
    executor: string;
    use: { byExecutor: Record<string, number>; byHost: Record<string, number>; local: number };
    expected: NonNullable<ReturnType<typeof queueCapacity>> | null;
  }>;
  for (const row of cases) {
    expect(queueCapacity(queueStrategy(true), row.executor, row.use) ?? null).toEqual(row.expected);
  }
});

const surrogateGoldens = JSON.parse(readFileSync(new URL("./fixtures/task-admission/surrogate-goldens.json", import.meta.url), "utf8")) as Array<{
  id: string; rawJson?: string; inputJson?: string; accept: boolean; expectedJson?: string; problemsJson?: string;
}>;
for (const row of surrogateGoldens) test(`surrogate golden: ${row.id}`, () => {
  if (row.rawJson !== undefined) {
    const raw = JSON.parse(row.rawJson);
    if (!row.accept) expect(() => parseDelegateBrief(raw, "/tmp")).toThrow();
    else {
      const { brief, ...input } = parseDelegateBrief(raw, "/tmp");
      if (row.expectedJson !== undefined) {
        expect(JSON.parse(JSON.stringify({ brief, input }))).toEqual(JSON.parse(row.expectedJson));
      }
    }
  }
  if (row.inputJson !== undefined) {
    const problems = validateInput(strategy, JSON.parse(row.inputJson));
    expect(problems.length === 0).toBe(row.accept);
    if (row.problemsJson !== undefined) expect(problems).toEqual(JSON.parse(row.problemsJson));
  }
});

test("pending dependency goldens match work admission", async () => {
  const { createTask, updateTask } = await import("../src/tasks/store");
  const { registerWork, pendingDependencies } = await import("../src/dispatch/work");
  const { dispatchDatabase } = await import("../src/dispatch/store");
  const rows = JSON.parse(readFileSync(new URL("./fixtures/task-admission/dependency-goldens.json", import.meta.url), "utf8")) as Array<{id:string;dependencies:string[];tasks:Record<string,{review?:{accepted:boolean}}>;waivers:string[];expected:string[]}>;
  for (const row of rows) {
    const ctx = fakeCtx();
    const make = () => createTask(ctx, {brief:{goal:"work",repo:ctx.home},kind:"feature",requestedExecutor:null,timeoutS:60});
    const root = make();
    registerWork(ctx, root.id);
    const ids: Record<string,string> = {};
    for (const [name, value] of Object.entries(row.tasks)) {
      const task = make(); ids[name] = task.id;
      if (value.review) updateTask(ctx, task.id, t => { t.review = {accepted:value.review!.accepted} as typeof t.review; });
    }
    const resolve = (name:string) => ids[name] ?? name;
    const db = dispatchDatabase(ctx);
    db.query("UPDATE work_nodes SET dependencies=? WHERE task_id=?").run(JSON.stringify(row.dependencies.map(resolve)), root.id);
    for (const name of row.waivers) db.query("INSERT INTO work_dependency_waivers(task_id,dependency_id,reason,at) VALUES(?,?,?,?)").run(root.id, resolve(name), "fixture", ctx.now);
    expect(pendingDependencies(ctx, root.id)).toEqual(row.expected.map(resolve));
  }
});

const strategyGoldens = JSON.parse(readFileSync(new URL("./fixtures/task-admission/strategy-goldens.json", import.meta.url), "utf8")) as Array<{id:string;strategy:unknown;input:unknown;problems:string[]}>;
for (const row of strategyGoldens) test(`strategy validation golden: ${row.id}`, () => {
  expect(validateInput(validateStrategy(row.strategy, "test"), row.input as Parameters<typeof validateInput>[1])).toEqual(row.problems);
});

const numericAdmission = JSON.parse(readFileSync(new URL("./fixtures/task-admission/numeric-goldens.json", import.meta.url), "utf8")) as Array<{
  id: string; project?: unknown; mutation?: {expect_rev: number}; accept: boolean;
}>;
for (const row of numericAdmission.filter(row => row.project || row.mutation)) test(`numeric admission: ${row.id}`, async () => {
  const ctx = fakeCtx();
  if (row.project) {
    const {mkdirSync, writeFileSync} = await import("node:fs");
    const {join} = await import("node:path");
    const {readProjectStrategies} = await import("../src/config/project-strategies");
    mkdirSync(ctx.pacerHome, {recursive: true, mode: 0o700});
    writeFileSync(join(ctx.pacerHome, "project-strategies.json"), JSON.stringify(row.project), {mode: 0o600});
    if (row.accept) expect(readProjectStrategies(ctx)).toEqual(row.project as ReturnType<typeof readProjectStrategies>);
    else expect(() => readProjectStrategies(ctx)).toThrow("Invalid project strategies");
  }
  if (row.mutation) {
    const {callOp} = await import("../src/api/ops");
    const {createTask, updateTask} = await import("../src/tasks/store");
    const task = createTask(ctx, {brief: {goal: "review", repo: ctx.home}, kind: null, requestedExecutor: null, timeoutS: 60});
    updateTask(ctx, task.id, t => { t.state = "done"; }); // rev 2; valid fixture values conflict.
    try {
      await callOp(ctx, "task.review", {id: task.id, verdict: "accept", ...row.mutation});
      throw new Error("expected revision refusal");
    } catch (error) {
      expect((error as {code?: string}).code).toBe(row.accept ? "conflict" : "invalid_input");
    }
  }
});

const contextGoldens = JSON.parse(readFileSync(new URL("./fixtures/task-admission/context-goldens.json", import.meta.url), "utf8")) as Array<{id: string; aJson: string; bJson: string; same: boolean}>;
for (const row of contextGoldens) test(`context stringify: ${row.id}`, () => {
  expect(JSON.stringify(JSON.parse(row.aJson)) === JSON.stringify(JSON.parse(row.bJson))).toBe(row.same);
});
