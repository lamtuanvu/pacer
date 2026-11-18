import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { birthMatchesRun, stopOrphanedRun } from "../src/supervisor/orphan";

test("orphan cleanup cannot certify death when the process probe fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pacer-orphan-probe-"));
  const probe = spyOn(Bun, "spawnSync").mockImplementation(() => { throw new Error("ps unavailable"); });
  try {
    expect(await stopOrphanedRun(dir, 12345, 0, () => undefined)).toBe(false);
  } finally {
    probe.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("orphan cleanup refuses a changed stop owner before probing or signalling", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pacer-orphan-owner-"));
  const probe = spyOn(Bun, "spawnSync");
  try {
    expect(await stopOrphanedRun(dir, 12345, 0, () => { throw new Error("owner changed"); })).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  } finally {
    probe.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("orphan cleanup never signals a group member older than the run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pacer-orphan-age-"));
  const child = Bun.spawn(["/bin/sleep", "60"], { detached: true });
  const wrapper = 999999;
  const original = Bun.spawnSync.bind(Bun);
  const probe = spyOn(Bun, "spawnSync").mockImplementation(((argv: string[], options: any) => {
    if (argv[0] === "ps" && argv[1] === "-axo") return {
      exitCode: 0, stdout: Buffer.from(`${child.pid} ${wrapper} S\n`), stderr: Buffer.alloc(0),
    };
    return original(argv, options);
  }) as typeof Bun.spawnSync);
  try {
    writeFileSync(join(dir, "started"), String(Date.now() / 1000 + 60));
    writeFileSync(join(dir, "child"), String(child.pid));
    expect(await stopOrphanedRun(dir, wrapper, 0, () => undefined)).toBe(false);
    expect(process.kill(child.pid, 0)).toBe(true);
  } finally {
    probe.mockRestore(); child.kill("SIGKILL"); await child.exited;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an interactive group without its recorded child cannot certify cleanup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pacer-orphan-descendant-"));
  const descendant = Bun.spawn(["/bin/sleep", "60"], { detached: true });
  const original = Bun.spawnSync.bind(Bun);
  const probe = spyOn(Bun, "spawnSync").mockImplementation(((argv: string[], options: any) => {
    if (argv[0] === "ps" && argv[1] === "-axo") return {
      exitCode: 0, stdout: Buffer.from(`${descendant.pid} 999998 S\n`), stderr: Buffer.alloc(0),
    };
    return original(argv, options);
  }) as typeof Bun.spawnSync);
  try {
    writeFileSync(join(dir, "started"), String(Date.now() / 1000 - 10));
    writeFileSync(join(dir, "child"), "999998");
    writeFileSync(join(dir, "interactive.json"), "{}");
    expect(await stopOrphanedRun(dir, 999999, 0, () => undefined)).toBe(false);
    expect(process.kill(descendant.pid, 0)).toBe(true);
  } finally {
    probe.mockRestore(); descendant.kill("SIGKILL"); await descendant.exited;
    rmSync(dir, { recursive: true, force: true });
  }
});


test("interactive orphan cleanup refuses a child pid reused after the child record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pacer-orphan-reused-"));
  const child = Bun.spawn(["/bin/sleep", "60"], { detached: true });
  const wrapper = Bun.spawnSync(["/bin/sleep", "0"]).pid;
  try {
    writeFileSync(join(dir, "started"), String(Date.now() / 1000 - 60));
    writeFileSync(join(dir, "child"), String(child.pid));
    const recordedAt = new Date(Date.now() - 30_000);
    utimesSync(join(dir, "child"), recordedAt, recordedAt);
    writeFileSync(join(dir, "interactive.json"), "{}");
    expect(await stopOrphanedRun(dir, wrapper, 0, () => undefined)).toBe(false);
    expect(process.kill(child.pid, 0)).toBe(true);
  } finally {
    child.kill("SIGKILL"); await child.exited;
    rmSync(dir, { recursive: true, force: true });
  }
});

// Inject Linux's boot clock so these regressions also run on macOS.

const linuxClock = { bootTime: 1_700_000_000, ticksPerSecond: 100 };
const linuxIdentity = { pid: 12345, bootId: "fixture-boot", birth: "1000" };

test("Linux orphan birth tolerates truncated boot seconds and one clock tick", () => {
  const birth = linuxClock.bootTime + 10;
  // The real process starts just after the run, but btime loses its fraction.
  expect(birthMatchesRun(linuxIdentity, birth + 0.999, birth + 1.005, linuxClock)).toBe(true);
  expect(birthMatchesRun(linuxIdentity, birth + 1.02, birth + 1.03, linuxClock)).toBe(false);
  // Group-member validation uses the same lower bound without a child mtime.
  expect(birthMatchesRun(linuxIdentity, birth + 0.999, Infinity, linuxClock)).toBe(true);
  expect(birthMatchesRun(linuxIdentity, birth + 1.02, Infinity, linuxClock)).toBe(false);
});

test("Linux orphan birth refuses a reused child beyond clock precision", () => {
  const birth = linuxClock.bootTime + 10;
  expect(birthMatchesRun(linuxIdentity, birth - 60, birth - 1, linuxClock)).toBe(true);
  expect(birthMatchesRun(linuxIdentity, birth - 60, birth - 1.02, linuxClock)).toBe(false);
  expect(birthMatchesRun(linuxIdentity, birth - 60, birth - 30, linuxClock)).toBe(false);
});

test("Darwin orphan birth retains exact run and child record comparisons", () => {
  const identity = { ...linuxIdentity, birth: "1700000010:500000" };
  const birth = 1_700_000_010.5;
  expect(birthMatchesRun(identity, birth, birth, "darwin")).toBe(true);
  expect(birthMatchesRun(identity, birth + 0.001, Infinity, "darwin")).toBe(false);
  expect(birthMatchesRun(identity, birth - 60, birth - 0.001, "darwin")).toBe(false);
});

test("orphan birth comparison fails closed for invalid clock or identity", () => {
  expect(birthMatchesRun(linuxIdentity, 1, Infinity, { ...linuxClock, ticksPerSecond: 0 })).toBe(false);
  expect(birthMatchesRun({ ...linuxIdentity, birth: "invalid" }, 1, Infinity, linuxClock)).toBe(false);
  expect(birthMatchesRun(linuxIdentity, NaN, Infinity, linuxClock)).toBe(false);
  expect(birthMatchesRun(linuxIdentity, 1, NaN, linuxClock)).toBe(false);
});
