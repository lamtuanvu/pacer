import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { captureBroker } from "../desktop/capture-broker";
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
  capture?: boolean;
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
export function register(ctx: Ctx, options: RegisterOptions): { client_id: string; lease_s: number; capture_worker?: string } {
  if (options.capture && options.kind !== "desktop") throw new CoreError("invalid_input", "Only desktop clients can register a capture worker");
  // Lapsed entries are kept a day so a waking client can renew, then dropped.
  const entries = read(ctx).filter(entry => ctx.now - entry.heartbeatAt <= KEEP_S);
  const client_id = randomUUID();
  entries.push({ kind: options.kind, version: options.version, notifier: options.notifier ?? false, client_id, registeredAt: ctx.now, heartbeatAt: ctx.now });
  writeJsonAtomic(path(ctx), entries);
  return { client_id, lease_s: LEASE_S, ...(options.capture ? { capture_worker: captureBroker(ctx.pacerHome).register(client_id) } : {}) };
}

export function heartbeat(ctx: Ctx, id: string): { ok: true } {
  const entries = read(ctx);
  const entry = entries.find(entry => entry.client_id === id);
  if (!entry) throw new CoreError("invalid_input", `unknown client "${id}"`);
  entry.heartbeatAt = ctx.now;
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
