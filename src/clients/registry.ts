import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { CoreError } from "../core/errors";
import { readJson, writeJsonAtomic } from "../fsutil";
import type { Ctx } from "../types";

export const CLIENT_KINDS = ["app", "desktop", "orca", "tui", "status", "tray", "cli"] as const;
const LEASE_S = 30;
const LAPSE_S = 45;
export interface RegisterOptions {
  kind: typeof CLIENT_KINDS[number];
  version: string;
  notifier?: boolean;
}
const entrySchema = z.object({
  client_id: z.string().min(1),
  kind: z.enum(CLIENT_KINDS),
  version: z.string().min(1),
  notifier: z.boolean(),
  registeredAt: z.number(),
  heartbeatAt: z.number(),
});
export type ClientEntry = z.infer<typeof entrySchema>;

const path = (ctx: Ctx) => join(ctx.pacerHome, "state", "clients.json");
function read(ctx: Ctx): ClientEntry[] {
  const parsed = z.array(entrySchema).safeParse(readJson<unknown>(path(ctx)));
  return parsed.success ? parsed.data : [];
}
const live = (ctx: Ctx, entry: ClientEntry) => ctx.now - entry.heartbeatAt <= LAPSE_S;

const KEEP_S = 86400;
export function register(ctx: Ctx, options: RegisterOptions): { client_id: string; lease_s: number } {
  // Lapsed entries are kept a day so a waking client can renew, then dropped.
  const entries = read(ctx).filter(entry => ctx.now - entry.heartbeatAt <= KEEP_S);
  const client_id = randomUUID();
  entries.push({ ...options, notifier: options.notifier ?? false, client_id, registeredAt: ctx.now, heartbeatAt: ctx.now });
  writeJsonAtomic(path(ctx), entries);
  return { client_id, lease_s: LEASE_S };
}

/** A boolean `notifier` replaces the stored flag so a client can stop or resume presenting. */
export function heartbeat(ctx: Ctx, id: string, notifier?: boolean): { ok: true } {
  const entries = read(ctx);
  const entry = entries.find(entry => entry.client_id === id);
  if (!entry) throw new CoreError("invalid_input", `unknown client "${id}"`);
  entry.heartbeatAt = ctx.now;
  if (notifier !== undefined) entry.notifier = notifier;
  writeJsonAtomic(path(ctx), entries);
  return { ok: true };
}

/** Connected clients only; expired entries remain stored so a waking client can renew. */
export function list(ctx: Ctx): ClientEntry[] {
  return read(ctx).filter(entry => live(ctx, entry));
}

export function activeNotifier(ctx: Ctx): ClientEntry | null {
  // Storage order also resolves registrations made within the same clock tick.
  return list(ctx).reverse().find(entry => entry.notifier) ?? null;
}

export type DeliveryMedium = "os" | "terminal" | "browser";

export type DeliveryPresenter = {
  client_id: string;
  kind: ClientEntry["kind"];
  medium: DeliveryMedium;
};

export function mediumFor(kind: ClientEntry["kind"]): DeliveryMedium | null {
  switch (kind) {
    case "desktop":
      return "os";
    case "tui":
      return "terminal";
    case "app":
      return "browser";
    default:
      return null;
  }
}

export function deliveryPresenters(ctx: Ctx): DeliveryPresenter[] {
  const pick = (medium: DeliveryMedium): ClientEntry | undefined =>
    list(ctx)
      .slice()
      .reverse()
      .find(entry => entry.notifier && mediumFor(entry.kind) === medium);

  const os = pick("os");
  const terminal = pick("terminal");
  const browser = pick("browser");
  const presenters: DeliveryPresenter[] = [];
  if (os) presenters.push({ client_id: os.client_id, kind: os.kind, medium: "os" });
  if (terminal) presenters.push({ client_id: terminal.client_id, kind: terminal.kind, medium: "terminal" });
  if (browser && !os) presenters.push({ client_id: browser.client_id, kind: browser.kind, medium: "browser" });
  return presenters;
}
