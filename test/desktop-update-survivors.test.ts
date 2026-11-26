import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCtx } from "../src/ctx";
import {
  beginWorkSync, claimWorkSync, attachRunEvidenceSync, finishWorkSync, maintenanceReserved, markRunSurvivorsSync,
  markSurvivorSync, releaseReservation, reserveIdle, survivorSupport, SURVIVOR_LEASES_SINCE,
} from "../src/update/desktop/admission";
import { CoreError } from "../src/core/errors";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function context() {
  const root = mkdtempSync(join(tmpdir(), "pacer-survivors-")); roots.push(root);
  return makeCtx({ home: root, pacerHome: join(root, "state"), env: {} });
}
const row = (ctx: ReturnType<typeof context>) => {
  const db = new Database(join(ctx.pacerHome, "desktop-updates/admission.sqlite"), { readonly: true });
  try { return JSON.parse(db.query<{ state: string }, []>("SELECT state FROM admission WHERE id = 1").get()!.state); }
  finally { db.close(); }
};
function claimed(ctx: ReturnType<typeof context>, blocker: { kind: "task" | "session" | "operation" | "launch"; id: string; label: string }) {
  const lease = beginWorkSync(ctx, blocker); claimWorkSync(ctx, lease); return lease;
}
/** A stored running task with an unfinished run directory, as a live runner leaves it. */
function runningTask(ctx: ReturnType<typeof context>, id: string): string {
  mkdirSync(join(ctx.pacerHome, "tasks"), { recursive: true });
  writeFileSync(join(ctx.pacerHome, "tasks", `${id}.json`), JSON.stringify({ id, state: "running", brief: { goal: "g", repo: "/r" }, attempts: [], title: id }));
  const dir = join(ctx.pacerHome, "runs", id, "1");
  mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "pid"), String(process.pid));
  return dir;
}

test("survivor leases and the stored work they cover stop blocking only when support is declared", async () => {
  const ctx = context(), task = "t-20261126-000000-aaaa", dir = runningTask(ctx, task);
  const runner = claimed(ctx, { kind: "task", id: task, label: `Task ${task}` });
  const session = claimed(ctx, { kind: "session", id: "s", label: "Executor session" });
  attachRunEvidenceSync(ctx, session, dir);
  markSurvivorSync(ctx, runner); markRunSurvivorsSync(ctx, dir);
  expect(row(ctx).leases.map((lease: { class?: string }) => lease.class)).toEqual(["survivor", "survivor"]);

  // Without declared support (an older helper, service or target) nothing changes: wait for idle.
  const waiting = await reserveIdle(ctx, "tx-a");
  expect(waiting.reserved).toBe(false);
  expect(waiting.blockers.map(b => b.kind).sort()).toEqual(["session", "session", "task", "task"]);
  expect(row(ctx).survivors).toBeUndefined();

  // With support, survivors and the task/run they own are not blockers; the reservation records it.
  expect(await reserveIdle(ctx, "tx-a", { survivors: true, target: "0.18.7" })).toEqual({ reserved: true, blockers: [] });
  expect(row(ctx)).toMatchObject({ reservation: "tx-a", survivors: true });
  // No new work starts during the reservation, and the refusal is recognizable for waiting callers.
  let refusal: unknown;
  try { beginWorkSync(ctx, { kind: "operation", id: task, label: "Executor attempt" }); } catch (error) { refusal = error; }
  expect(maintenanceReserved(refusal)).toBe(true);
  // A survivor that finishes still releases its own lease.
  finishWorkSync(ctx, runner);
  await releaseReservation(ctx, "tx-a");
  expect(row(ctx).survivors).toBeUndefined();
  expect(row(ctx).reservation).toBeNull();
});

test("an ordinary lease or uncovered stored work still blocks a survivor reservation", async () => {
  const ctx = context(), task = "t-20261126-000000-bbbb";
  runningTask(ctx, task);
  const runner = claimed(ctx, { kind: "task", id: "other-task", label: "Task other" });
  markSurvivorSync(ctx, runner);
  const queue = claimed(ctx, { kind: "operation", id: "queue-drain", label: "Queue drain" });
  const result = await reserveIdle(ctx, "tx-b", { survivors: true, target: "0.18.7" });
  expect(result.reserved).toBe(false);
  expect(result.blockers.map(b => b.label)).toEqual(["Queue drain", task, `Session ${task}`]);
  finishWorkSync(ctx, queue);
  expect(row(ctx).reservation).toBeNull();
});

test("only this incarnation's local leases can be marked", () => {
  const ctx = context();
  const pending = beginWorkSync(ctx, { kind: "launch", id: "l", label: "Launch" });
  markSurvivorSync(ctx, pending); // pending leases have an identity but are marked only through their run
  const db = new Database(join(ctx.pacerHome, "desktop-updates/admission.sqlite"));
  const state = JSON.parse(db.query<{ state: string }, []>("SELECT state FROM admission WHERE id = 1").get()!.state);
  state.leases.push({ id: crypto.randomUUID(), blocker: { kind: "session", id: "x", label: "Foreign" }, owner: crypto.randomUUID(), process: null, state: "pending", runDir: "/r" });
  db.query("UPDATE admission SET state = ? WHERE id = 1").run(JSON.stringify(state)); db.close();
  markSurvivorSync(ctx, state.leases[1].id);
  markRunSurvivorsSync(ctx, "/r");
  expect(row(ctx).leases[1].class).toBeUndefined();
});

test("support needs the installed bundle (helper and rollback target) and the update target", () => {
  expect(survivorSupport(SURVIVOR_LEASES_SINCE, SURVIVOR_LEASES_SINCE, false)).toBe(true);
  expect(survivorSupport("0.19.0", "0.19.1", false)).toBe(true);
  expect(survivorSupport("0.18.6", "0.19.0", false)).toBe(false);
  expect(survivorSupport("0.19.0", "0.18.6", false)).toBe(false);
  expect(survivorSupport("0.19.0", undefined, false)).toBe(false);
  expect(survivorSupport("not-a-version", "0.19.0", false)).toBe(false);
  // Only a compiled OTA fixture build (its own 0.2.x versions) is exempt from the release floor.
  expect(survivorSupport("0.2.3", "0.2.4", true)).toBe(true);
  expect(survivorSupport("0.2.3", undefined, true)).toBe(false);
  // Tests run uncompiled: no fixture policy, so the default is the release floor.
  expect(survivorSupport("0.2.3", "0.2.4")).toBe(false);
  expect(maintenanceReserved(new CoreError("conflict", "Desktop reservation conflict"))).toBe(false);
});

test("an older service's strict schema drops survivor data and falls back to waiting", async () => {
  const { z } = await import("zod");
  // The v0.18.6 admission shapes: unknown members are stripped, so a survivor lease is ordinary.
  const legacyLease = z.object({ id: z.string(), blocker: z.object({ kind: z.string(), id: z.string(), label: z.string() }), owner: z.string(), process: z.unknown(), state: z.string() });
  const legacy = z.object({ schema: z.literal(1), reservation: z.string().nullable(), leases: z.array(legacyLease) });
  const ctx = context();
  markSurvivorSync(ctx, claimed(ctx, { kind: "task", id: "t", label: "Task t" }));
  const parsed = legacy.parse(row(ctx));
  expect(JSON.stringify(parsed)).not.toContain("survivor");
  expect((await reserveIdle(ctx, "tx-c")).reserved).toBe(false);
});

test("a surviving runner's next attempt waits for the swap instead of failing", async () => {
  const { withAttemptWork, resetHandoverState } = await import("../src/tasks/handover");
  const ctx = context();
  expect((await reserveIdle(ctx, "tx-d")).reserved).toBe(true);
  let slept = 0;
  const result = await withAttemptWork(ctx, "t-1", async () => "ran", {
    pollMs: 1, sleep: async () => { if (++slept === 2) await releaseReservation(ctx, "tx-d"); },
  });
  expect(result).toBe("ran");
  expect(slept).toBe(2);
  // A bounded wait still fails when the update never finishes.
  expect((await reserveIdle(ctx, "tx-e")).reserved).toBe(true);
  await expect(withAttemptWork(ctx, "t-2", async () => "ran", { maxMs: 0, sleep: async () => {} })).rejects.toThrow("maintenance");
  resetHandoverState();
});

test("a PTY run's lease is a start until its session host claims it", async () => {
  const ctx = context(), task = "t-20261126-000000-cccc", dir = runningTask(ctx, task);
  writeFileSync(join(dir, "session.json"), "{}");
  // The runner began the session lease (pending) and advertised handover before the host claimed it.
  const pending = beginWorkSync(ctx, { kind: "session", id: "s", label: "Executor session" });
  attachRunEvidenceSync(ctx, pending, dir);
  markRunSurvivorsSync(ctx, dir);
  expect(row(ctx).leases[0].class).toBeUndefined();
  const result = await reserveIdle(ctx, "tx-f", { survivors: true, target: "0.18.7" });
  expect(result.reserved).toBe(false);
  expect(result.blockers.map(b => b.label)).toContain("Executor session");
  finishWorkSync(ctx, pending);
});

test("a session host survives only within the target's support window", async () => {
  const { writeSessionVersion } = await import("../src/session/protocol");
  const { currentVersion } = await import("../src/update/version");
  const ctx = context(), task = "t-20261126-000000-dddd", dir = runningTask(ctx, task);
  writeFileSync(join(dir, "session.json"), "{}");
  const host = claimed(ctx, { kind: "session", id: "h", label: "Executor session" });
  attachRunEvidenceSync(ctx, host, dir);
  markSurvivorSync(ctx, host);
  // No session.version yet: the host is not proven supported, so it blocks.
  expect((await reserveIdle(ctx, "tx-g", { survivors: true, target: currentVersion() })).reserved).toBe(false);
  writeSessionVersion(dir, null);
  const [major, minor] = currentVersion().split(".").map(Number);
  expect((await reserveIdle(ctx, "tx-g", { survivors: true, target: `${major}.${minor + 4}.0` })).reserved).toBe(false);
  expect((await reserveIdle(ctx, "tx-g", { survivors: true, target: currentVersion() })).reserved).toBe(true);
  // A survivor reservation without a target never admits survivors.
  await releaseReservation(ctx, "tx-g");
  expect((await reserveIdle(ctx, "tx-h", { survivors: true })).reserved).toBe(false);
});
