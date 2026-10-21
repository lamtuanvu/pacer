import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireLease, processIdentity, sameProcess } from "../scripts/live/control/lease";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() { const value = mkdtempSync(join(tmpdir(), "pacer-lease-")); roots.push(value); return value; }
test("two writers cannot own same scope, even with different worktrees", async () => {
  const base = root(); const lease = await acquireLease("desktop", { run_id: "one" }, base);
  await expect(acquireLease("desktop", { run_id: "two" }, base)).rejects.toThrow("busy");
  await lease.release(); const second = await acquireLease("desktop", { run_id: "two" }, base); await second.release();
});
test("late heartbeat never steals a live owner", async () => {
  const base = root(); const lease = await acquireLease("desktop", { run_id: "one" }, base);
  const file = join(base, "desktop", "owner.json");
  const data = JSON.parse(readFileSync(file, "utf8")); data.heartbeat_at = 0; writeFileSync(file, JSON.stringify(data));
  await expect(acquireLease("desktop", { run_id: "two" }, base)).rejects.toThrow("busy"); await lease.release();
});
test("PID with different start identity is not the owner", async () => {
  const identity = await processIdentity(process.pid); expect(identity).not.toBeNull();
  expect(await sameProcess({ pid: process.pid, start_identity: "old-process" })).toBe(false);
  expect(await sameProcess(identity!)).toBe(true);
});
test("release cannot remove a replacement owner's lease", async () => {
  const base = root(); const lease = await acquireLease("web-main", { run_id: "one" }, base);
  const file = join(base, "web-main", "owner.json");
  const owner = JSON.parse(readFileSync(file, "utf8")); owner.nonce = "replacement"; writeFileSync(file, JSON.stringify(owner));
  await lease.release(); expect(JSON.parse(readFileSync(file, "utf8")).nonce).toBe("replacement");
});

test("teardown never signals a desktop with mismatched recorded identity", async () => {
  const { down } = await import("../scripts/live/core");
  const { mkdirSync } = await import("node:fs");
  const base = root(); for (const dir of ["repo", "evidence", "bin"]) mkdirSync(join(base, dir));
  const original = process.kill; const signals: number[] = [];
  process.kill = ((pid: number, signal?: string | number) => { if (signal !== 0) signals.push(pid); return true; }) as typeof process.kill;
  try {
    await expect(down({ id: "review-owned", root: base, port: 1, pid: 0, createdAt: "now", stopped: true, desktopPid: process.pid, desktopIdentity: { pid: process.pid, start_identity: "mismatch" } }, true)).rejects.toThrow("identity");
    expect(signals).toEqual([]);
  } finally { process.kill = original; }
});
