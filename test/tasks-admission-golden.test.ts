import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseDelegateBrief, validateInput } from "../src/tasks/api";
import { queueCapacity } from "../src/tasks/capacity";
import { validateStrategy } from "../src/config/strategy";
import { queueStrategy } from "./queue-helpers";
import { fakeCtx } from "./helpers";
import { slotUse } from "../src/engine/slots";
import { setMachineReaders } from "../src/engine/machine";
import { capacityFixture } from "./read-model-helpers";
import type { TaskRecord } from "../src/tasks/types";

interface Golden {
  id: string;
  raw: Record<string, unknown>;
  brief?: Record<string, unknown>;
  input?: Record<string, unknown>;
  error?: string;
}
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
  finally { setMachineReaders(); }
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
