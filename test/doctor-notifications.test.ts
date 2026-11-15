import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { fakeCtx } from "./helpers";
import { register } from "../src/clients/registry";
import { setLevel } from "../src/core/notify";
import { writeJsonAtomic } from "../src/fsutil";
import { notificationsCheck } from "../src/install/notifications-check";
import { remedies } from "../src/install/doctor-remedy";

function healthPath(ctx: any) {
  return join(ctx.pacerHome, "state", "notification-health.json");
}

test("doctor notifications: off", () => {
  const ctx = fakeCtx();
  setLevel(ctx, "off");
  const c = notificationsCheck(ctx);
  expect(c.level).toBe("info");
  expect(c.detail).toBe("Notifications are off");
});

test("doctor notifications: no live desktop", () => {
  const ctx = fakeCtx();
  const c = notificationsCheck(ctx);
  expect(c.level).toBe("info");
  expect(c.detail).toBe("The pacer app isn't open; banners come from the system fallback");
  expect(c.evidence).toBe("unverified");
});

test("doctor notifications: unsupported", () => {
  const ctx = fakeCtx();
  register(ctx, { kind: "desktop", version: "1", notifier: true, notification_permission: "unsupported" });
  const c = notificationsCheck(ctx);
  expect(c.level).toBe("info");
  expect(c.detail).toBe("This development build can't post banners");
});

test("doctor notifications: not_determined", () => {
  const ctx = fakeCtx();
  register(ctx, { kind: "desktop", version: "1", notifier: true, notification_permission: "not_determined" });
  const c = notificationsCheck(ctx);
  expect(c.level).toBe("warn");
  expect(c.detail).toBe("Notification permission not asked yet");
  expect(c.remedy).toEqual(remedies.allowNotifications());
});

test("doctor notifications: denied", () => {
  const ctx = fakeCtx();
  register(ctx, { kind: "desktop", version: "1", notifier: true, notification_permission: "denied" });
  const c = notificationsCheck(ctx);
  expect(c.level).toBe("warn");
  expect(c.detail).toBe("Notifications are blocked in System Settings");
  expect(c.remedy).toEqual(remedies.notificationSettings("Turn on Allow notifications for pacer"));
});

test("doctor notifications: provisional", () => {
  const ctx = fakeCtx();
  register(ctx, { kind: "desktop", version: "1", notifier: true, notification_permission: "provisional", notification_alerts: "banner" });
  const c = notificationsCheck(ctx);
  expect(c.level).toBe("warn");
  expect(c.detail).toBe("Notifications arrive quietly, without banners");
  expect(c.remedy).toEqual(remedies.notificationSettings("Choose Banners for pacer"));
});

test("doctor notifications: alerts none", () => {
  const ctx = fakeCtx();
  register(ctx, { kind: "desktop", version: "1", notifier: true, notification_permission: "authorized", notification_alerts: "none" });
  const c = notificationsCheck(ctx);
  expect(c.level).toBe("warn");
  expect(c.detail).toBe("Notifications arrive quietly, without banners");
  expect(c.remedy).toEqual(remedies.notificationSettings("Choose Banners for pacer"));
});

test("doctor notifications: last_error newer than last_ok_at", () => {
  const ctx = fakeCtx();
  register(ctx, { kind: "desktop", version: "1", notifier: true, notification_permission: "authorized", notification_alerts: "banner" });
  writeJsonAtomic(healthPath(ctx), { last_ok_at: 100, last_error: { at: 200, message: "boom" } });
  const c = notificationsCheck(ctx);
  expect(c.level).toBe("warn");
  expect(c.detail).toBe("The banner was rejected: boom");
  expect(c.remedy).toEqual(remedies.testNotification());
});

test("doctor notifications: unacked 15s timeout", () => {
  const ctx = fakeCtx();
  register(ctx, { kind: "desktop", version: "1", notifier: true, notification_permission: "authorized", notification_alerts: "banner" });
  const sent = ctx.now - 20;
  writeJsonAtomic(healthPath(ctx), { key: "test:1", client_id: "x", sent_at: sent });
  const c = notificationsCheck(ctx);
  expect(c.level).toBe("warn");
  expect(c.detail).toBe("The desktop didn't confirm the test notification");
  expect(c.remedy).toEqual(remedies.testNotification());
});

test("doctor notifications: ok tested", () => {
  const ctx = fakeCtx();
  register(ctx, { kind: "desktop", version: "1", notifier: true, notification_permission: "authorized", notification_alerts: "banner" });
  const sent = ctx.now - 5;
  const acked = ctx.now - 1;
  writeJsonAtomic(healthPath(ctx), { key: "test:1", client_id: "x", sent_at: sent, acked_at: acked, delivered: true });
  const c = notificationsCheck(ctx);
  expect(c.level).toBe("ok");
  expect(c.evidence).toBe("tested");
  expect(c.detail).toContain("Banners allowed · test delivered");
});

test("doctor notifications: ok untested", () => {
  const ctx = fakeCtx();
  register(ctx, { kind: "desktop", version: "1", notifier: true, notification_permission: "authorized", notification_alerts: "banner" });
  const c = notificationsCheck(ctx);
  expect(c.level).toBe("ok");
  expect(c.detail).toBe("Banners allowed · not tested yet");
  expect(c.evidence).toBe("configured");
});