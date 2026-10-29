import { describe, expect, test } from "bun:test";
import { parseOutboxEvent, reduce, emptySnapshot, contentKey, summaryLine, liveConsole, type OutboxEvent } from "../src/link/envelope";

const budget = { generatedAt: 1, strategy: "default", planner: "claude-code", mode: "normal", providers: [{ id: "claude-code", verdict: "ON_PACE", pacePct:null,usedPct: 61.4, resetsAt: null, window: null, stale: false }], ranked: [{ id: "codex", verdict: "OK" }] };
const envs: OutboxEvent[] = [
  { type: "budget", data: budget },
  { type: "task", data: { id: "t1", state: "running", goal: "go", executor: null, backend: null, worktree: null, updatedAt: 2 } },
  { type: "mode", data: { mode: "normal", previous: null, strategy: "default", at: 1 } },
  { type: "alert", data: { key: "a", level: "info", title: "hi", body: "there", at: 1 } },
];
describe("link envelope", () => {
  test("accepts a machine entity and rejects malformed machine entities", () => {
    const machine = { type: "entity", data: { kind: "machine", id: "machine-1", value: { label: "Local" } } } as const;
    expect(parseOutboxEvent(machine)).toEqual(machine);
    expect(parseOutboxEvent({ type: "entity", data: { kind: "machine", id: "machine-1", removed: true } }))
      .toEqual({ type: "entity", data: { kind: "machine", id: "machine-1", removed: true } });
    for (const data of [null, { kind: "machine" }, { kind: "machine", id: "" }, { kind: "machine", id: 1 }, { kind: "machine", id: "x".repeat(129) }, { kind: "machines", id: "machine-1" }]) {
      expect(parseOutboxEvent({ type: "entity", data })).toBeNull();
    }
  });
  test("four envelope types round trip", () => { for (const e of envs) expect(parseOutboxEvent(JSON.parse(JSON.stringify(e)))).toEqual(e); });
  test("rejects invalid version, type, missing data and malformed budget", () => {
    for (const x of [{ v: 2, type: "mode", data: {} }, { type: "what", data: {} }, { type: "mode" }, { type: "budget", data: { generatedAt: 1, strategy: "x", mode: "normal" } }]) expect(parseOutboxEvent(x)).toBeNull();
  });
  test("clips long values and parses legacy errors", () => {
    expect(parseOutboxEvent({ ...envs[1], data: { ...envs[1].data, goal: "x".repeat(10000) } })?.type === "task" && (parseOutboxEvent({ ...envs[1], data: { ...envs[1].data, goal: "x".repeat(10000) } }) as any).data.goal).toHaveLength(200);
    const a = parseOutboxEvent({ type: "alert", data: { title: "x".repeat(200), error: "YAML bad" } }) as any;
    expect(a.data.title).toHaveLength(120); expect(a.data.title.endsWith("...")).toBe(true); expect(a.data.level).toBe("error"); expect(a.data.body).toBe("YAML bad");
  });
  test("reduce upserts and caps ordered tasks and alerts", () => {
    let s = emptySnapshot(); for (let i = 0; i < 25; i++) s = reduce(s, { type: "task", data: { id: `t${i}`, state: "running", goal: "", executor: null, backend: null, worktree: null, updatedAt: i } }, i);
    s = reduce(s, { type: "task", data: { id: "t24", state: "done", goal: "", executor: null, backend: null, worktree: null, updatedAt: 30 } }, 30);
    expect(s.tasks).toHaveLength(20); expect(s.tasks[0]?.id).toBe("t24"); expect(s.tasks[0]?.state).toBe("done");
    for (let i = 0; i < 12; i++) s = reduce(s, { type: "alert", data: { key: `a${i}`, level: "info", title: "", body: "", at: i } }, i);
    s = reduce(s, { type: "alert", data: { key: "a11", level: "warn", title: "changed", body: "", at: 20 } }, 20);
    expect(s.alerts).toHaveLength(10); expect(s.alerts[0]?.key).toBe("a11"); expect(s.seq).toBe(39);
  });
  test("content identity ignores sequence and receive time", () => { const a = reduce(emptySnapshot(), envs[0]!, 10); const b = { ...a, seq: 99, at: 88 }; expect(contentKey(a)).toBe(contentKey(b)); });
  test("summary and console liveness", () => {
    expect(summaryLine(null)).toBe("pacer: no budget data yet"); expect(summaryLine(budget)).toBe("pacer normal | claude-code 61% ON_PACE | next: codex"); expect(summaryLine(budget).length).toBeLessThanOrEqual(120);
    const s = { ...emptySnapshot(), console: { handle: "h", paneKey: null, pid: 1, startedAt: 1, heartbeatAt: 100 } }; expect(liveConsole(s, 130)).not.toBeNull(); expect(liveConsole(s, 131)).toBeNull(); expect(liveConsole({ ...s, console: { ...s.console!, handle: null } }, 101)).toBeNull();
  });
});

test("pacePct accepts only finite numbers and old budgets still parse",()=>{
 for(const [value,expected] of [[undefined,null],[null,null],[28.4,28.4],[NaN,null],[Infinity,null],["25",null]]) {
  const parsed=parseOutboxEvent({type:"budget",data:{...budget,providers:[{...budget.providers[0],pacePct:value}]}}) as any;
  expect(parsed.data.providers[0].pacePct).toBe(expected);
 }
});
test("task progress round-trips and is validated", () => {
  const data = { id: "t-1", state: "running", goal: "g", executor: "codex", backend: "direct", worktree: null, updatedAt: 1,
    progress: { phase: "working", lastOutputAt: 5, files: 2, commits: 1, logBytes: 300 } };
  expect(parseOutboxEvent({ type: "task", data })).toMatchObject({ data: { progress: data.progress } });
  expect(parseOutboxEvent({ type: "task", data: { ...data, progress: { phase: 3 } } })?.data).not.toHaveProperty("progress");
});
