import { describe, expect, test } from "bun:test";
import { encodeCmdLine, decodeCmdLine, parseEnvelope, reduce, emptySnapshot, contentKey, summaryLine, liveConsole, type Envelope } from "../src/link/envelope";

const budget = { generatedAt: 1, strategy: "default", planner: "claude-code", mode: "normal", providers: [{ id: "claude-code", verdict: "ON_PACE", usedPct: 61.4, resetsAt: null, window: null, stale: false }], ranked: [{ id: "codex", verdict: "OK" }] };
const envs: Envelope[] = [
  { v: 1, type: "budget", data: budget },
  { v: 1, type: "task", data: { id: "t1", state: "running", goal: "go", executor: null, backend: null, worktree: null, updatedAt: 2 } },
  { v: 1, type: "mode", data: { mode: "normal", previous: null, strategy: "default", at: 1 } },
  { v: 1, type: "alert", data: { key: "a", level: "info", title: "hi", body: "there", at: 1 } },
];
describe("link envelope", () => {
  test("four envelope types round trip", () => { for (const e of envs) expect(parseEnvelope(JSON.parse(JSON.stringify(e)))).toEqual(e); });
  test("rejects invalid version, type, missing data and malformed budget", () => {
    for (const x of [{ v: 2, type: "mode", data: {} }, { v: 1, type: "what", data: {} }, { v: 1, type: "mode" }, { v: 1, type: "budget", data: { generatedAt: 1, strategy: "x", mode: "normal" } }]) expect(parseEnvelope(x)).toBeNull();
  });
  test("clips long values and parses legacy errors", () => {
    expect(parseEnvelope({ ...envs[1], data: { ...envs[1].data, goal: "x".repeat(10000) } })?.type === "task" && (parseEnvelope({ ...envs[1], data: { ...envs[1].data, goal: "x".repeat(10000) } }) as any).data.goal).toHaveLength(200);
    const a = parseEnvelope({ v: 1, type: "alert", data: { title: "x".repeat(200), error: "YAML bad" } }) as any;
    expect(a.data.title).toHaveLength(120); expect(a.data.title.endsWith("...")).toBe(true); expect(a.data.level).toBe("error"); expect(a.data.body).toBe("YAML bad");
  });
  test("reduce upserts and caps ordered tasks and alerts", () => {
    let s = emptySnapshot(); for (let i = 0; i < 25; i++) s = reduce(s, { v: 1, type: "task", data: { id: `t${i}`, state: "running", goal: "", executor: null, backend: null, worktree: null, updatedAt: i } }, i);
    s = reduce(s, { v: 1, type: "task", data: { id: "t24", state: "done", goal: "", executor: null, backend: null, worktree: null, updatedAt: 30 } }, 30);
    expect(s.tasks).toHaveLength(20); expect(s.tasks[0]?.id).toBe("t24"); expect(s.tasks[0]?.state).toBe("done");
    for (let i = 0; i < 12; i++) s = reduce(s, { v: 1, type: "alert", data: { key: `a${i}`, level: "info", title: "", body: "", at: i } }, i);
    s = reduce(s, { v: 1, type: "alert", data: { key: "a11", level: "warn", title: "changed", body: "", at: 20 } }, 20);
    expect(s.alerts).toHaveLength(10); expect(s.alerts[0]?.key).toBe("a11"); expect(s.seq).toBe(39);
  });
  test("content identity ignores sequence and receive time", () => { const a = reduce(emptySnapshot(), envs[0]!, 10); const b = { ...a, seq: 99, at: 88 }; expect(contentKey(a)).toBe(contentKey(b)); });
  test("command line safely round trips, parses suffixes, rejects malformed or unknown commands", () => {
    const line = encodeCmdLine({ cmd: "use", branch: "it's fine" }); expect(line.startsWith(": pacer '")).toBe(true); expect(line.endsWith("'")).toBe(true); expect(line).not.toContain("it's");
    expect(decodeCmdLine(line).cmd?.data.branch).toBe("it's fine"); expect(decodeCmdLine(`abc${line}`).before).toBe("abc");
    expect(decodeCmdLine("abc: pacer '{bad}'")).toEqual({ before: "abc: pacer '{bad}'", cmd: null }); expect(decodeCmdLine(": pacer '{\"v\":1,\"type\":\"cmd\",\"data\":{\"cmd\":\"nope\"}}'").cmd).toBeNull();
  });
  test("command line is shell inert and enforces length", () => {
    const line = encodeCmdLine({ cmd: "use", branch: "main" }); const r = Bun.spawnSync(["sh", "-c", line]); expect(r.exitCode).toBe(0); expect(r.stdout.toString()).toBe("");
    expect(() => encodeCmdLine({ cmd: "use", branch: "x".repeat(4096) })).toThrow();
  });
  test("summary and console liveness", () => {
    expect(summaryLine(null)).toBe("pacer: no budget data yet"); expect(summaryLine(budget)).toBe("pacer normal | claude-code 61% ON_PACE | next: codex"); expect(summaryLine(budget).length).toBeLessThanOrEqual(120);
    const s = { ...emptySnapshot(), console: { handle: "h", paneKey: null, pid: 1, startedAt: 1, heartbeatAt: 100 } }; expect(liveConsole(s, 130)).not.toBeNull(); expect(liveConsole(s, 131)).toBeNull(); expect(liveConsole({ ...s, console: { ...s.console!, handle: null } }, 101)).toBeNull();
  });
});
