import { cpus, loadavg } from "node:os";
import type { ExecutionCfg } from "../config/execution";

/** macOS kern.memorystatus_vm_pressure_level: 1 normal, 2 warning, 4 critical. */
export type MemoryPressure = "normal" | "warning" | "critical";
const PRESSURE_LEVELS: Record<number, MemoryPressure> = {1: "normal", 2: "warning", 4: "critical"};
const RANK: Record<MemoryPressure, number> = {normal: 0, warning: 1, critical: 2};

export interface MachineReaders {
  /** Raw pressure level, or null when the signal is unavailable. */
  pressure(): number | null;
  /** 1-minute load average and CPU cores, or null when unavailable. */
  load(): {avg1: number; cores: number} | null;
}
export interface MachineSignals {
  memoryPressure: MemoryPressure | null;
  loadPerCore: number | null;
  sampledAt: number;
}
export interface MachineGuard {
  reason: "machine_memory_pressure" | "machine_load";
  detail: string;
  machine: {memoryPressure?: MemoryPressure; memoryPressureLimit?: "warning" | "critical"; loadPerCore?: number; loadLimit?: number};
}

/** Scheduling decisions within this window share one sample instead of spawning sysctl each time. */
export const MACHINE_SAMPLE_MS = 5000;

const systemReaders: MachineReaders = {
  pressure() {
    if (process.platform !== "darwin") return null;
    try {
      const out = Bun.spawnSync(["/usr/sbin/sysctl", "-n", "kern.memorystatus_vm_pressure_level"], {stdout: "pipe", stderr: "ignore", timeout: 2000});
      if (out.exitCode !== 0) return null;
      const n = Number(out.stdout.toString().trim());
      return Number.isInteger(n) ? n : null;
    } catch { return null; }
  },
  load() {
    // Windows reports a constant zero load average.
    if (process.platform === "win32") return null;
    const cores = cpus().length, avg1 = loadavg()[0];
    return cores > 0 && Number.isFinite(avg1) ? {avg1, cores} : null;
  },
};
let readers: MachineReaders = systemReaders;
let cached: MachineSignals | null = null;

/** Replace the signal readers (tests); omitted readers fall back to the system. Clears the sample cache. */
export function setMachineReaders(next?: Partial<MachineReaders>): void {
  readers = {...systemReaders, ...next};
  cached = null;
}

export function machineSignals(now = Date.now()): MachineSignals {
  if (cached && now - cached.sampledAt >= 0 && now - cached.sampledAt < MACHINE_SAMPLE_MS) return cached;
  let raw: number | null = null, load: {avg1: number; cores: number} | null = null;
  try { raw = readers.pressure(); } catch { raw = null; }
  try { load = readers.load(); } catch { load = null; }
  cached = {
    memoryPressure: raw === null ? null : PRESSURE_LEVELS[raw] ?? null,
    loadPerCore: load && load.cores > 0 ? Math.round(load.avg1 / load.cores * 100) / 100 : null,
    sampledAt: now,
  };
  return cached;
}

/**
 * Whether a new local task may start now. Only gates starts: running tasks are
 * never touched. Missing signals keep the guard open.
 */
export function machineGuard(exec: Pick<ExecutionCfg, "localMemoryPressureLimit" | "localLoadLimit">, signals: MachineSignals = machineSignals()): MachineGuard | null {
  const limit = exec.localMemoryPressureLimit ?? "critical";
  const pressure = signals.memoryPressure;
  if (limit !== "off" && pressure !== null && RANK[pressure] >= RANK[limit]) {
    return {reason: "machine_memory_pressure", detail: `memory pressure ${pressure}`, machine: {memoryPressure: pressure, memoryPressureLimit: limit}};
  }
  const loadLimit = exec.localLoadLimit ?? null, load = signals.loadPerCore;
  if (loadLimit !== null && load !== null && load > loadLimit) {
    return {reason: "machine_load", detail: `load ${formatLoad(load)}/core over limit ${formatLoad(loadLimit)}`, machine: {loadPerCore: load, loadLimit}};
  }
  return null;
}

export function formatLoad(n: number): string {
  return String(Math.round(n * 10) / 10);
}

/** Plain-words status for settings: what each guard sees now. */
export function machineGuardState(exec: Pick<ExecutionCfg, "localMemoryPressureLimit" | "localLoadLimit">, signals: MachineSignals = machineSignals()) {
  const guard = machineGuard(exec, signals);
  return {
    memoryPressure: signals.memoryPressure,
    memoryPressureLimit: exec.localMemoryPressureLimit ?? "critical",
    loadPerCore: signals.loadPerCore,
    loadLimit: exec.localLoadLimit ?? null,
    open: guard === null,
    ...(guard ? {reason: guard.reason, detail: guard.detail} : signals.memoryPressure === null && (exec.localMemoryPressureLimit ?? "critical") !== "off" ? {detail: "memory pressure signal unavailable"} : {}),
  };
}
