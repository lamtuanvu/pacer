import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopOrphanedRun } from "../src/supervisor/orphan";

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
