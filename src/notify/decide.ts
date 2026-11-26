import { join } from "node:path";
import type { Action, AttentionItem } from "../attention/types";
import { CALLER_GONE_AFTER_S, NOTIFY_COOLDOWN_S, sortItems } from "../attention/rules";
import { deliveryPresenters } from "../clients/registry";
import { withLock } from "../core/lock";
import { getLevel, type NotificationLevel } from "../core/notify";
import { readJson, writeJsonAtomic } from "../fsutil";
import type { OutboxEvent } from "../link/envelope";
import { publish, type PublishReport } from "../link/publish";
import type { Ctx } from "../types";
import { pluginRegistry } from "../plugins";
import { appendPluginLog } from "../plugins/host";
import { notifierResources } from "../plugins/notifier-resources";
import { notificationResult } from "../plugins/notifier-protocol";
import { CoreError } from "../core/errors";

export { CALLER_GONE_AFTER_S, NOTIFY_COOLDOWN_S };

export interface NotifyData { key: string; title: string; body: string; actions: Action[]; url: string; recipients?: string[]; client_id?: string }
export type DeliveryLedger = Record<string, number>;
export type NotifyCandidate = { key: string; data: NotifyData; /** Extra ledger keys to mark when this candidate is sent (siblings / group members). */ ackKeys?: string[] };

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

/** Latest delivery time for an attention id: exact key or any `${id}:${since}` ledger entry. */
function lastNotifiedAt(ledger: DeliveryLedger, id: string): number | null {
  const prefix = `${id}:`;
  let latest: number | null = null;
  for (const [key, at] of Object.entries(ledger)) {
    if (key !== id && !key.startsWith(prefix)) continue;
    if (latest === null || at > latest) latest = at;
  }
  return latest;
}

/** True when `now` is set and this attention id was delivered within the cooldown window. */
function inCooldown(ledger: DeliveryLedger, id: string, now: number): boolean {
  if (now <= 0) return false;
  const last = lastNotifiedAt(ledger, id);
  return last !== null && now - last < NOTIFY_COOLDOWN_S;
}

/** The planner kind in a caller participant (`external:claude-code:<session>` → `claude-code`). */
const callerLabel = (p?: string) => /^external:([a-z-]+)/.exec(p ?? "")?.[1] ?? "the caller";

function itemKey(item: AttentionItem): string {
  return `${item.id}:${item.since}`;
}

function candidateFromItem(item: AttentionItem): NotifyCandidate {
  const key = itemKey(item);
  return { key, data: { key, title: item.title, body: item.detail, actions: item.actions.slice(0, 2), url: `/app/#/${notificationView(item)}` } };
}

/** Group important items waiting on an external caller into one banner per caller.
 *  Includes stalled tasks and planner-owned run blocking items (both carry
 *  `waitingOn`), so a silent caller cannot strand either with many banners. */
function callerGoneCandidates(items: AttentionItem[], ledger: DeliveryLedger, now: number): NotifyCandidate[] {
  const byCaller = new Map<string, AttentionItem[]>();
  for (const item of items) {
    if (item.notify !== "important" || !item.waitingOn) continue;
    const list = byCaller.get(item.waitingOn) ?? [];
    list.push(item);
    byCaller.set(item.waitingOn, list);
  }
  const grouped: NotifyCandidate[] = [];
  for (const [caller, members] of byCaller) {
    // Caller-only key: cooldown (not a permanent since-keyed id) lets a newly
    // joining member re-banner after NOTIFY_COOLDOWN_S.
    const key = `caller_gone:${caller}`;
    if (now > 0 ? inCooldown(ledger, key, now) : Object.hasOwn(ledger, key)) continue;
    const head = members[0]!;
    const n = members.length;
    grouped.push({
      key,
      data: {
        key,
        title: `${callerLabel(caller)} has not responded`,
        body: `${n} delegated task${n === 1 ? "" : "s"} waiting`,
        actions: head.actions.slice(0, 2),
        url: `/app/#/${notificationView(head)}`,
      },
      ackKeys: members.map(itemKey),
    });
  }
  return grouped;
}

/** One candidate per taskId (most severe first); ackKeys cover same-task siblings. */
function onePerTask(items: AttentionItem[]): NotifyCandidate[] {
  const keysByTask = new Map<string, string[]>();
  for (const item of items) {
    if (!item.taskId) continue;
    const keys = keysByTask.get(item.taskId) ?? [];
    keys.push(itemKey(item));
    keysByTask.set(item.taskId, keys);
  }
  const seenTask = new Set<string>();
  const out: NotifyCandidate[] = [];
  for (const item of items) {
    if (!item.taskId) {
      out.push(candidateFromItem(item));
      continue;
    }
    if (seenTask.has(item.taskId)) continue;
    seenTask.add(item.taskId);
    const c = candidateFromItem(item);
    const keys = keysByTask.get(item.taskId)!;
    // First key is this winner; remaining same-task keys are ledger-acked with the send.
    if (keys.length > 1) c.ackKeys = keys.slice(1);
    out.push(c);
  }
  return out;
}

/**
 * Build notification candidates: level filter, per-id cooldown, one-per-task,
 * and grouped caller-gone banners. `ackKeys` on a candidate are ledger-acked
 * with the sent key so suppressed siblings do not fire next pass.
 */
export function toNotify(items: AttentionItem[], level: NotificationLevel, ledger: DeliveryLedger, now = 0): NotifyCandidate[] {
  if (level === "off") return [];
  const eligible: AttentionItem[] = [];
  for (const item of sortItems([...items])) {
    if (level === "important" && item.notify !== "important") continue;
    if (Object.hasOwn(ledger, itemKey(item)) || inCooldown(ledger, item.id, now)) continue;
    eligible.push(item);
  }

  const grouped = callerGoneCandidates(eligible, ledger, now);
  // Caller-gone members stay out of per-task even when the group itself was skipped (ledger/cooldown).
  const callerGoneIds = new Set(
    eligible.filter(i => i.notify === "important" && i.waitingOn).map(i => i.id),
  );
  return [...grouped, ...onePerTask(eligible.filter(i => !callerGoneIds.has(i.id)))];
}

export interface DispatchDeps {
  publish?: (ctx: Ctx, events: OutboxEvent[]) => Promise<PublishReport>;
  /** Enabled notifier ids; always tried in id order. */
  notifiers?: string[];
  deliver?: (pluginId: string, data: NotifyData) => Promise<boolean>;
  /** Transition envelopes add mode changes and settled tasks at level all. */
  events?: OutboxEvent[];
  /** Called after all eligible candidates are durably acknowledged (or none qualify). */
  onAcknowledged?: () => void;
}
function warnNotifier(ctx: Ctx, id: string, message: string): void {
  try { appendPluginLog(ctx, id, "warn", message); } catch { /* A failed diagnostic cannot stop notification retries. */ }
}
const clip = (text: string, max: number) => text.length <= max ? text : text.slice(0, max - 1) + "…";
async function deliverWithPlugins(ctx: Ctx, full: NotifyData, deps: DispatchDeps): Promise<boolean> {
  // The notifier protocol bounds title and body; clip so long attention text is still delivered once.
  const data = { ...full, title: clip(full.title, 256), body: clip(full.body, 2048) };
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
    const candidates = toNotify(items, level, ledger, ctx.now);
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
    let failed = false;
    for (const { key, data, ackKeys } of candidates) {
      if (Object.hasOwn(ledger, key)) continue;
      const presenters = deliveryPresenters(ctx);
      let delivered: boolean;
      if (presenters.length > 0) {
        const recipients = presenters.map(presenter => presenter.client_id);
        const client_id = presenters.find(presenter => presenter.medium === "os")?.client_id ?? recipients[0];
        const event: OutboxEvent = { type: "entity", data: { kind: "notify", id: key, value: { ...data, recipients, client_id } } };
        const report = await (deps.publish ?? publish)(ctx, [event]);
        delivered = report.transports.includes("outbox");
        if (delivered) sent.push(event);
      } else delivered = await deliverWithPlugins(ctx, data, deps);
      if (!delivered) failed = true;
      if (delivered) {
        ledger[key] = ctx.now;
        for (const ack of ackKeys ?? []) ledger[ack] = ctx.now;
        writeJsonAtomic(path, ledger);
      }
    }
    writeJsonAtomic(path, ledger);
    if (!failed) deps.onAcknowledged?.();
    return sent;
  });
}
