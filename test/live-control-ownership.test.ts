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
