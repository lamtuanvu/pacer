import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readJson, writeJsonAtomic } from "../fsutil";
import { withLock } from "../core/lock";
import type { Ctx } from "../types";
import { CoreError } from "../core/errors";
import { deliveryPresenters, list as listClients } from "../clients/registry";
import { publish } from "../link/publish";
import type { OutboxEvent } from "../link/envelope";

export interface NotificationHealthRecord {
  key?: string;
  client_id?: string;
  sent_at?: number;
  last_ok_at?: number;
  last_error?: { at: number; message: string };
  acked_at?: number;
  delivered?: boolean;
}

const healthPath = (ctx: Ctx) => join(ctx.pacerHome, "state", "notification-health.json");

export function readHealth(ctx: Ctx): NotificationHealthRecord | null {
  const raw = readJson<unknown>(healthPath(ctx));
  if (!raw || typeof raw !== "object") return null;
  return raw as NotificationHealthRecord;
}

export async function testNotification(ctx: Ctx): Promise<{ key: string; client_id: string; sent_at: number }> {
  const presenters = deliveryPresenters(ctx);
  const os = presenters.find(p => p.medium === "os");
  if (!os) {
    const hasDesktop = listClients(ctx).some(c => c.kind === "desktop");
    if (hasDesktop) {
      throw new CoreError("unavailable", "macOS blocks pacer notifications", "Turn on Allow notifications for pacer in System Settings › Notifications.");
    }
    throw new CoreError("unavailable", "no live desktop presenter", "Open the pacer app, then retry.");
  }
  const key = `test:${randomUUID()}`;
  const event: OutboxEvent = { type: "entity", data: { kind: "notify", id: key, value: { key, title: "pacer test notification", body: "If you see this, banners work.", recipients: [os.client_id], client_id: os.client_id } } };
  const report = await publish(ctx, [event]);
  if (!report.transports.includes("outbox")) throw new CoreError("unavailable", "notification publish failed");
  const sent_at = ctx.now;
  await withLock(ctx, "notifications", async () => {
    const current = readHealth(ctx) ?? {};
    const next: NotificationHealthRecord = { ...current, key, client_id: os.client_id, sent_at };
    delete next.acked_at;
    delete next.delivered;
    writeJsonAtomic(healthPath(ctx), next);
  });
  return { key, client_id: os.client_id, sent_at };
}

export async function ackNotification(ctx: Ctx, key: string, delivered: boolean, error?: string): Promise<{ ok: true }> {
  await withLock(ctx, "notifications", async () => {
    const now = ctx.now;
    const current = readHealth(ctx) ?? {};
    const next: NotificationHealthRecord = { ...current };
    if (delivered) next.last_ok_at = now;
    else next.last_error = { at: now, message: error ?? "delivery failed" };
    if (current.key && current.key === key) {
      next.acked_at = now;
      next.delivered = delivered;
    }
    writeJsonAtomic(healthPath(ctx), next);
  });
  return { ok: true };
}

export async function requestAuthorization(ctx: Ctx, opts: { wait_s?: number } = {}): Promise<{ client_id: string; permission?: string }> {
  // Target the newest LIVE desktop client regardless of notifier so the macOS
  // permission prompt reaches whatever desktop is running.
  const live = listClients(ctx).slice().reverse();
  const desktop = live.find(c => c.kind === "desktop");
  if (!desktop) throw new CoreError("unavailable", "no live desktop client", "Open the pacer app, then retry.");
  const event: OutboxEvent = { type: "entity", data: { kind: "control", id: `notifications.request:${randomUUID()}`, value: { action: "notifications.request", recipients: [desktop.client_id], client_id: desktop.client_id } } };
  await publish(ctx, [event]);
  const waitMs = (opts.wait_s ?? 30) * 1000;
  const deadline = Date.now() + waitMs;
  let permission = desktop.notification_permission;
  // Poll the registry until the desktop reports the macOS answer, or until wait_s
  // runs out. The last value seen is returned either way.
  while (Date.now() <= deadline) {
    const entry = listClients(ctx).find(c => c.client_id === desktop.client_id);
    if (entry) permission = entry.notification_permission;
    if (permission && permission !== "not_determined") break;
    await Bun.sleep(500);
  }
  const last = listClients(ctx).find(c => c.client_id === desktop.client_id);
  return { client_id: desktop.client_id, permission: last?.notification_permission };
}
