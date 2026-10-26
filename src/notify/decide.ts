import { join } from "node:path";
import type { Action, AttentionItem } from "../attention/types";
import { needsReview } from "../api/read-model/tasks";
import { activeNotifier } from "../clients/registry";
import { withLock } from "../core/lock";
import { getLevel, type NotificationLevel } from "../core/notify";
import { readJson, writeJsonAtomic } from "../fsutil";
import type { OutboxEvent } from "../link/envelope";
import { publish } from "../link/publish";
import type { Ctx } from "../types";
import { pluginRegistry } from "../plugins";
import { appendPluginLog } from "../plugins/host";
import { notifierResources } from "../plugins/notifier-resources";
import { notificationResult } from "../plugins/notifier-protocol";
import { CoreError } from "../core/errors";

export interface NotifyData { key: string; title: string; body: string; actions: Action[]; url: string; client_id?: string }
export type DeliveryLedger = Record<string, number>;
function notificationView(item: AttentionItem): string {
  const section = item.actions.find(a => a.op === "ui.open" && a.params.view === "settings")?.params.section;
  if (typeof section === "string") return `settings/${encodeURIComponent(section)}`;
  if (item.kind === "update") return "settings/updates";
  if (item.taskId) return `tasks/${encodeURIComponent(item.taskId)}`;
  if (item.executor) return "settings/executors";
  if (item.account) return "settings/accounts";
  if (item.host) return `settings/hosts/${encodeURIComponent(item.host)}`;
  return "";
}
export function toNotify(items: AttentionItem[], level: NotificationLevel, ledger: DeliveryLedger): { key: string; data: NotifyData }[] {
  if (level === "off") return [];
  const seen = new Set(Object.keys(ledger));
  return items.flatMap(item => {
    const key = `${item.id}:${item.since}`;
    if (seen.has(key) || level === "important" && item.notify !== "important") return [];
    seen.add(key);
    return [{ key, data: { key, title: item.title, body: item.detail, actions: item.actions.slice(0, 2), url: `/app/#/${notificationView(item)}` } }];
  });
}
export interface DispatchDeps {
  publish?: typeof publish;
  /** Enabled notifier ids; always tried in id order. */
  notifiers?: string[];
  deliver?: (pluginId: string, data: NotifyData) => Promise<boolean>;
  /** Transition envelopes add mode changes and settled tasks at level all. */
  events?: OutboxEvent[];
}
function warnNotifier(ctx: Ctx, id: string, message: string): void {
  try { appendPluginLog(ctx, id, "warn", message); } catch { /* A failed diagnostic cannot stop notification retries. */ }
}
async function deliverWithPlugins(ctx: Ctx, data: NotifyData, deps: DispatchDeps): Promise<boolean> {
  let ids: string[];
  try {
    ids = [...(deps.notifiers ?? pluginRegistry(ctx).findAll(ctx, "notifier"))].sort();
  } catch {
    warnNotifier(ctx, "pacer-notify", "notifier discovery failed");
    return false;
  }
  for (const id of ids) {
    try {
      let delivered: unknown;
      if (deps.deliver) delivered = await deps.deliver(id, data);
      else {
        const message = { key: data.key, title: data.title, body: data.body, url: data.url };
        const result = await pluginRegistry(ctx).call(ctx, id, "notifier.deliver", message, {
          resources: notifierResources(process.platform, data.title, data.body), deadlineMs: 5000,
        });
        const parsed = notificationResult.safeParse(result);
        if (!parsed.success) throw new CoreError("plugin_refused", "notifier returned an invalid delivery result");
        delivered = parsed.data.delivered;
      }
      if (typeof delivered !== "boolean") throw new CoreError("plugin_refused", "notifier returned an invalid delivery result");
      if (delivered === true) return true;
    } catch {
      warnNotifier(ctx, id, "notifier.deliver failed");
    }
  }
  return false;
}
export async function dispatchNotifications(ctx: Ctx, items: AttentionItem[], deps: DispatchDeps = {}): Promise<OutboxEvent[]> {
  return withLock(ctx, "notifications", async () => {
    const path = join(ctx.pacerHome, "state", "notified.json");
    const raw = readJson<DeliveryLedger>(path) ?? {};
    const ledger: DeliveryLedger = Object.fromEntries(Object.entries(raw).filter(([, at]) => typeof at === "number" && at >= ctx.now - 7 * 86400));
    const level = getLevel(ctx).level;
    const candidates = toNotify(items, level, ledger);
    if (level === "all") for (const event of deps.events ?? []) {
      if (event.type === "mode" && event.data.previous !== null) {
        const d = event.data, key = `mode:${d.mode}:${d.at}`;
        candidates.push({ key, data: { key, title: `Budget mode changed to ${d.mode}`, body: `${d.previous} → ${d.mode}`, actions: [], url: "/app/#/" } });
      } else if (event.type === "task" && ["done", "partial", "failed", "limit", "stopped"].includes(event.data.state) && !items.some(item => item.taskId === event.data.id)) {
        const d = event.data, key = `task:${d.id}:${d.state}:${d.updatedAt}`;
        candidates.push({ key, data: { key, title: `Task ${d.state}`, body: d.goal, actions: [], url: `/app/#/tasks/${encodeURIComponent(d.id)}` } });
      }
    }
    const sent: OutboxEvent[] = [];
    for (const { key, data } of candidates) {
      if (Object.hasOwn(ledger, key)) continue;
      const notifier = activeNotifier(ctx);
      let delivered: boolean;
      if (notifier) {
        const event: OutboxEvent = { type: "entity", data: { kind: "notify", id: key, value: { ...data, client_id: notifier.client_id } } };
        const report = await (deps.publish ?? publish)(ctx, [event]);
        delivered = report.transports.includes("outbox");
        if (delivered) sent.push(event);
      } else delivered = await deliverWithPlugins(ctx, data, deps);
      if (delivered) {
        ledger[key] = ctx.now;
        writeJsonAtomic(path, ledger);
      }
    }
    writeJsonAtomic(path, ledger);
    return sent;
  });
}
