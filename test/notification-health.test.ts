import { expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { register, heartbeat } from "../src/clients/registry";
import { callOp } from "../src/api/ops";
import {
  readHealth,
  testNotification,
  ackNotification,
  requestAuthorization,
  REQUEST_DEFAULT_WAIT_S,
  REQUEST_MAX_WAIT_S,
} from "../src/core/notification-health";
import type { EntityData } from "../src/link/envelope";

// B6-3: the five ops now have `nativeOnly` TS handlers. These cases drive the
// reference functions directly; the published schema refusals still go via callOp.

test("testNotification with no desktop presenter fails", async () => {
  const ctx = fakeCtx();
  await expect(testNotification(ctx)).rejects.toMatchObject({ code: "unavailable" });
});

test("testNotification writes a record targeting the desktop client", async () => {
  const ctx = fakeCtx();
  const desktop = register(ctx, { kind: "desktop", version: "1", notifier: true });
  const result = await testNotification(ctx);
  expect(result.key).toMatch(/^test:/);
  expect(result.client_id).toBe(desktop.client_id);
  const health = readHealth(ctx);
  expect(health?.key).toBe(result.key);
  expect(health?.client_id).toBe(desktop.client_id);
});

test("ack of matching key sets acked_at and delivered", async () => {
  const ctx = fakeCtx();
  const desktop = register(ctx, { kind: "desktop", version: "1", notifier: true });
  const { key } = await testNotification(ctx);
  const before = readHealth(ctx)!.sent_at!;
  await ackNotification(ctx, desktop.client_id, key, true);
  const health = readHealth(ctx)!;
  expect(health.acked_at).toBeGreaterThanOrEqual(before);
  expect(health.delivered).toBe(true);
  expect(health.last_ok_at).toBeDefined();
});

test("ack of unknown key only updates last_ok_at/last_error", async () => {
  const ctx = fakeCtx();
  const desktop = register(ctx, { kind: "desktop", version: "1", notifier: true });
  const { key } = await testNotification(ctx);
  const beforeAcked = readHealth(ctx)!.acked_at;
  await ackNotification(ctx, desktop.client_id, "unknown", false, "boom");
  const health = readHealth(ctx)!;
  expect(health.last_error?.message).toBe("boom");
  expect(health.acked_at).toBe(beforeAcked);
  expect(health.key).toBe(key);
});

test("the op handler is native-only in TypeScript", async () => {
  const ctx = fakeCtx();
  await expect(callOp(ctx, "notifications.test", {})).rejects.toMatchObject({ code: "unavailable" });
});

test("state file mode is 0600", async () => {
  const ctx = fakeCtx();
  register(ctx, { kind: "desktop", version: "1", notifier: true });
  await testNotification(ctx);
  const mode = statSync(join(ctx.pacerHome, "state", "notification-health.json")).mode & 0o777;
  expect(mode).toBe(0o600);
});

test("requestAuthorization publishes a targeted control event that replays with recipients", async () => {
  const { replayOutbox } = await import("../src/link/outbox-index");
  const { eventsSince } = await import("../src/api/events");
  const ctx = fakeCtx();
  const desktop = register(ctx, { kind: "desktop", version: "1", notifier: true });
  await requestAuthorization(ctx, { wait_s: 0 });
  const after = replayOutbox(ctx, 0).entries;
  const control = after.find(e => e.envelope.type === "entity" && e.envelope.data.kind === "control");
  expect(control).toBeDefined();
  const value = (control!.envelope.data as EntityData).value;
  expect(value).toMatchObject({ action: "notifications.request", recipients: [desktop.client_id], client_id: desktop.client_id });
  const v3 = eventsSince(ctx, 0, 3).events;
  expect(v3.some(e => e.type === "control" && (e.data as { recipients?: string[] }).recipients?.includes(desktop.client_id))).toBe(true);
  const v2 = eventsSince(ctx, 0, 2).events;
  expect(v2.some(e => e.type === "control")).toBe(false);
});

test("requestAuthorization targets the newest live desktop and returns its permission with wait_s 0", async () => {
  const ctx = fakeCtx();
  register(ctx, { kind: "desktop", version: "1", notifier: true, notification_permission: "denied" });
  const newest = register(ctx, { kind: "desktop", version: "1", notifier: false, notification_permission: "authorized" });
  const result = await requestAuthorization(ctx, { wait_s: 0 });
  expect(result.client_id).toBe(newest.client_id);
  expect(result.permission).toBe("authorized");
});

test("requestAuthorization fails unavailable with no live desktop", async () => {
  const ctx = fakeCtx();
  await expect(requestAuthorization(ctx, { wait_s: 0 })).rejects.toMatchObject({ code: "unavailable" });
});

test("requestAuthorization polls until the permission changes during the wait", async () => {
  const ctx = fakeCtx();
  const desktop = register(ctx, { kind: "desktop", version: "1", notification_permission: "not_determined" });
  let t = 0;
  let changed = false;
  const clock = {
    now: () => t,
    sleep: async () => {
      t += 500;
      if (!changed) {
        changed = true;
        heartbeat(ctx, desktop.client_id, { notification_permission: "authorized" });
      }
    },
  };
  const result = await requestAuthorization(ctx, { wait_s: 2 }, clock);
  expect(result.client_id).toBe(desktop.client_id);
  expect(result.permission).toBe("authorized");
});

test("testNotification with a live desktop that is not a presenter fails with the macOS hint", async () => {
  const ctx = fakeCtx();
  register(ctx, { kind: "desktop", version: "1", notifier: false, notification_permission: "denied" });
  await expect(testNotification(ctx)).rejects.toMatchObject({
    code: "unavailable",
    message: "macOS blocks pacer notifications",
    hint: "Turn on Allow notifications for pacer in System Settings › Notifications.",
  });
});

test("ack accepts the desktop's real payload with error:null (B1)", async () => {
  const ctx = fakeCtx();
  const desktop = register(ctx, { kind: "desktop", version: "1", notifier: true });
  const { key } = await testNotification(ctx);
  const result = await ackNotification(ctx, desktop.client_id, key, true, null);
  expect(result).toEqual({ ok: true });
  const health = readHealth(ctx)!;
  expect(health.delivered).toBe(true);
  expect(health.acked_at).toBeGreaterThanOrEqual(health.sent_at!);
});

test("ack stores a control-character-free error message", async () => {
  const ctx = fakeCtx();
  const desktop = register(ctx, { kind: "desktop", version: "1", notifier: true });
  const { key } = await testNotification(ctx);
  const messy = `boom\u001b[31m x\u0000y\u0085 tail`;
  await ackNotification(ctx, desktop.client_id, key, false, messy);
  const message = readHealth(ctx)!.last_error!.message;
  expect(message).toBe("boom[31m xy tail");
});

test("ack rejects an error longer than 512 characters at the schema", async () => {
  const ctx = fakeCtx();
  const desktop = register(ctx, { kind: "desktop", version: "1", notifier: true });
  const { key } = await testNotification(ctx);
  await expect(callOp(ctx, "notifications.ack", { client_id: desktop.client_id, key, delivered: false, error: "x".repeat(513) }))
    .rejects.toMatchObject({ code: "invalid_input" });
});

test("ack from a different live desktop for the pending key is rejected", async () => {
  const ctx = fakeCtx();
  register(ctx, { kind: "desktop", version: "1", notifier: true });
  const { key } = await testNotification(ctx);
  const other = register(ctx, { kind: "desktop", version: "1", notifier: false });
  await expect(ackNotification(ctx, other.client_id, key, true))
    .rejects.toMatchObject({ code: "not_allowed", message: "notifications.ack client mismatch" });
});

test("request uses the injectable clock and returns the last permission at the deadline", async () => {
  const ctx = fakeCtx();
  const desktop = register(ctx, { kind: "desktop", version: "1", notification_permission: "not_determined" });
  let t = 0;
  const clock = { now: () => t++, sleep: async () => {} };
  const result = await requestAuthorization(ctx, { wait_s: 1 }, clock);
  expect(result.client_id).toBe(desktop.client_id);
  expect(result.permission).toBe("not_determined");
});

test("request rejects a wait_s above 25 and defaults to 20 at the published schema", async () => {
  const ctx = fakeCtx();
  register(ctx, { kind: "desktop", version: "1", notifier: true });
  await expect(callOp(ctx, "notifications.request", { wait_s: 26 })).rejects.toMatchObject({ code: "invalid_input" });
  expect(REQUEST_DEFAULT_WAIT_S).toBe(20);
  expect(REQUEST_MAX_WAIT_S).toBe(25);
});
