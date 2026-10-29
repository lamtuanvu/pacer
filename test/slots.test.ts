import { expect, test } from "bun:test";
import { validateStrategy } from "../src/config/strategy";
import { afterEach } from "bun:test";
import { slotBlock, slotLimit, slotUse } from "../src/engine/slots";
import { machineGuard, machineSignals, setMachineReaders, MACHINE_SAMPLE_MS, type MachineSignals } from "../src/engine/machine";
import type { TaskRecord } from "../src/tasks/types";
const strategy = (extra = {}) => validateStrategy({ accounts: { claude: {kind: "claude"}, codex: {kind: "codex"}, cursor: {kind: "cursor"} }, planner: "claude-code", hosts: {box: {ssh: "box", max_tasks: 2}}, routing: [{default: ["codex", "cursor", "codex@box"]}], ...extra }, "test");
const task = (executor: string, host?: string, state = "running") => ({state, executor, ...(host ? {run: {executor, host}} : {})}) as TaskRecord;
test("executor, host, then machine limits win", () => {
  const s = strategy({execution: {local_max_tasks: 2}});
  expect(slotBlock(s, "codex", slotUse([task("codex")]))).toBe("Codex busy (1/1)");
  expect(slotBlock(s, "claude-code", slotUse([task("codex"), task("cursor")]))).toBe("this machine busy (2/2)");
  const use = slotUse([task("codex@box", "box"), task("codex@box", "box"), task("codex", undefined, "done")]);
  expect(use.local).toBe(0);
  expect(use.byHost.box).toBe(2);
  expect(slotBlock(s, "codex@box", use)).toBe("Codex busy (2/2)");
  expect(slotLimit(s, "codex@box")).toEqual({executor: 2, host: 2, local: null});
});
test("configured limits are validated and applied", () => {
  const s = strategy({runners: {codex: {max_tasks: 3}}, execution: {local_max_tasks: 4}});
  expect(slotLimit(s, "codex")).toEqual({executor: 3, host: null, local: 4});
  for (const n of [0, 17, 1.5]) expect(() => strategy({runners: {codex: {max_tasks: n}}})).toThrow("runners.codex.max_tasks must be 1..16");
  for (const n of [0, -2, 1.5, "8"]) expect(() => strategy({execution: {local_max_tasks: n}})).toThrow("execution.local_max_tasks must be a whole number");
  // The local cap has no upper ceiling.
  expect(slotLimit(strategy({execution: {local_max_tasks: 64}}), "codex").local).toBe(64);
});

test("remote tasks count against their host before a run reference exists", () => {
  expect(slotUse([task("codex@box")])).toEqual({byExecutor: {"codex@box": 1}, byHost: {box: 1}, local: 0});
  const s = strategy({runners: {"codex@box": {max_tasks: 3}}});
  expect(slotBlock(s, "codex@box", slotUse([task("codex@box"), task("codex@box")]))).toBe("box busy (2/2)");
});

const calm = () => setMachineReaders({pressure: () => 1, load: () => ({avg1: 0, cores: 1})});
afterEach(calm);
const signals = (memoryPressure: MachineSignals["memoryPressure"], loadPerCore: number | null = 0): MachineSignals => ({memoryPressure, loadPerCore, sampledAt: 0});

test("no fixed local cap by default; an explicit cap still applies", () => {
  const s = strategy();
  expect(slotLimit(s, "codex")).toEqual({executor: 1, host: null, local: null});
  const many = Array.from({length: 30}, (_, i) => task(`other-${i}`));
  expect(slotBlock(s, "codex", slotUse(many))).toBeNull();
  const capped = strategy({execution: {local_max_tasks: 3}});
  expect(slotBlock(capped, "codex", slotUse(many.slice(0, 3)))).toBe("this machine busy (3/3)");
  expect(slotBlock(strategy({execution: {local_max_tasks: "unlimited"}}), "codex", slotUse(many))).toBeNull();
});

test("memory pressure guard holds new local starts at or above each configured level", () => {
  const at = (limit: "critical" | "warning" | "off", level: MachineSignals["memoryPressure"]) => machineGuard({localMemoryPressureLimit: limit, localLoadLimit: null}, signals(level));
  expect(at("critical", "normal")).toBeNull();
  expect(at("critical", "warning")).toBeNull();
  expect(at("critical", "critical")).toEqual({reason: "machine_memory_pressure", detail: "memory pressure critical", machine: {memoryPressure: "critical", memoryPressureLimit: "critical"}});
  expect(at("warning", "normal")).toBeNull();
  expect(at("warning", "warning")).toMatchObject({reason: "machine_memory_pressure", detail: "memory pressure warning"});
  expect(at("warning", "critical")).toMatchObject({reason: "machine_memory_pressure", detail: "memory pressure critical"});
  expect(at("off", "critical")).toBeNull();
  // Unset defaults to critical.
  expect(machineGuard({}, signals("critical"))?.reason).toBe("machine_memory_pressure");
  expect(machineGuard({}, signals("warning"))).toBeNull();
});

test("the guard is open when the memory pressure signal is unavailable", () => {
  for (const limit of ["critical", "warning"] as const) expect(machineGuard({localMemoryPressureLimit: limit}, signals(null))).toBeNull();
  setMachineReaders({pressure: () => null, load: () => null});
  expect(machineSignals(1_000_000)).toEqual({memoryPressure: null, loadPerCore: null, sampledAt: 1_000_000});
  setMachineReaders({pressure: () => { throw new Error("sysctl failed"); }, load: () => ({avg1: 1, cores: 2})});
  expect(machineSignals(1_000_000).memoryPressure).toBeNull();
  setMachineReaders({pressure: () => 7, load: () => null});
  expect(machineSignals(1_000_000).memoryPressure).toBeNull();
  expect(slotBlock(strategy({execution: {local_memory_pressure_limit: "warning", local_load_limit: 1}}), "codex", slotUse([]), {guard: true})).toBeNull();
});

test("load guard holds new local starts only when load per core exceeds the limit", () => {
  expect(machineGuard({localLoadLimit: null}, signals("normal", 40))).toBeNull();
  expect(machineGuard({localLoadLimit: 3}, signals("normal", 3))).toBeNull();
  expect(machineGuard({localLoadLimit: 3}, signals("normal", 4.92))).toEqual({reason: "machine_load", detail: "load 4.9/core over limit 3", machine: {loadPerCore: 4.92, loadLimit: 3}});
  expect(machineGuard({localLoadLimit: 3}, signals("normal", null))).toBeNull();
  // Memory pressure is reported first when both hold.
  expect(machineGuard({localLoadLimit: 3}, signals("critical", 5))?.reason).toBe("machine_memory_pressure");
});

test("the machine guard applies to local runners only and reads one cached sample", () => {
  let reads = 0;
  setMachineReaders({pressure: () => { reads++; return 4; }, load: () => ({avg1: 59, cores: 12})});
  const s = strategy();
  expect(slotBlock(s, "codex", slotUse([]), {guard: true})).toBe("this machine waits: memory pressure critical");
  expect(slotBlock(s, "cursor", slotUse([]), {guard: true})).toBe("this machine waits: memory pressure critical");
  expect(slotBlock(s, "codex@box", slotUse([]), {guard: true})).toBeNull();
  // Without the guard option only hard caps apply (previews, admission checks, executor rows).
  expect(slotBlock(s, "codex", slotUse([]))).toBeNull();
  expect(reads).toBe(1);
  const now = Date.now();
  machineSignals(now + MACHINE_SAMPLE_MS + 1);
  expect(reads).toBe(2);
  expect(machineSignals(now + MACHINE_SAMPLE_MS + 2).loadPerCore).toBe(4.92);
  expect(reads).toBe(2);
});
