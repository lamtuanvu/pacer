import { join } from "node:path";
import type { Action, AttentionItem } from "../attention/types";
import { activeNotifier } from "../clients/registry";
import { withLock } from "../core/lock";
import { getLevel, type NotificationLevel } from "../core/notify";
import { readJson, writeJsonAtomic } from "../fsutil";
import type { Envelope } from "../link/envelope";
import { publish } from "../link/publish";
import type { Ctx } from "../types";
import { postFallback } from "./fallback";

export interface NotifyData { key: string; title: string; body: string; actions: Action[]; url: string; client_id?: string }
export type DeliveryLedger = Record<string, number>;
export function toNotify(items: AttentionItem[], level: NotificationLevel, ledger: DeliveryLedger): { key: string; data: NotifyData }[] {
  if (level === "off") return [];
  const seen = new Set(Object.keys(ledger));
  return items.flatMap(item => {
    const key = `${item.id}:${item.since}`;
    if (seen.has(key) || level === "important" && item.notify !== "important") return [];
    seen.add(key);
    const view = item.taskId ? `tasks/${encodeURIComponent(item.taskId)}` : item.executor ? `executors/${encodeURIComponent(item.executor)}` : item.account ? `accounts/${encodeURIComponent(item.account)}` : item.host ? `hosts/${encodeURIComponent(item.host)}` : "attention";
    return [{ key, data: { key, title: item.title, body: item.detail, actions: item.actions.slice(0, 2), url: `/app/#${view}` } }];
  });
}
export interface DispatchDeps {
  publish?: typeof publish;
  postFallback?: typeof postFallback;
  /** Transition envelopes add mode changes and settled tasks at level all. */
  events?: Envelope[];
}
export async function dispatchNotifications(ctx: Ctx, items: AttentionItem[], deps: DispatchDeps = {}): Promise<Envelope[]> {
  return withLock(ctx, "notifications", async () => {
    const path = join(ctx.pacerHome, "state", "notified.json");
    const raw = readJson<DeliveryLedger>(path) ?? {};
    const ledger: DeliveryLedger = Object.fromEntries(Object.entries(raw).filter(([, at]) => typeof at === "number" && at >= ctx.now - 7 * 86400));
    const level = getLevel(ctx).level;
    const candidates = toNotify(items, level, ledger);
    if (level === "all") for (const event of deps.events ?? []) {
      if (event.type === "mode" && event.data.previous !== null) {
        const d = event.data, key = `mode:${d.mode}:${d.at}`;
        candidates.push({ key, data: { key, title: `Budget mode changed to ${d.mode}`, body: `${d.previous} → ${d.mode}`, actions: [], url: "/app/#overview" } });
      } else if (event.type === "task" && ["done", "partial", "failed", "limit", "stopped"].includes(event.data.state) && !items.some(item => item.taskId === event.data.id)) {
        const d = event.data, key = `task:${d.id}:${d.state}:${d.updatedAt}`;
        candidates.push({ key, data: { key, title: `Task ${d.state}`, body: d.goal, actions: [], url: `/app/#tasks/${encodeURIComponent(d.id)}` } });
      }
    }
    const sent: Envelope[] = [];
    for (const { key, data } of candidates) {
      if (Object.hasOwn(ledger, key)) continue;
      const notifier = activeNotifier(ctx);
      let delivered: boolean;
      if (notifier) {
        const event: Envelope = { v: 1, type: "entity", data: { kind: "notify", id: key, value: { ...data, client_id: notifier.client_id } } };
        const report = await (deps.publish ?? publish)(ctx, [event], { channel: false, bridge: false });
        delivered = report.transports.includes("outbox");
        if (delivered) sent.push(event);
      } else delivered = await (deps.postFallback ?? postFallback)(data.title, data.body, ctx);
      if (delivered) {
        ledger[key] = ctx.now;
        writeJsonAtomic(path, ledger);
      }
    }
    writeJsonAtomic(path, ledger);
    return sent;
  });
}
