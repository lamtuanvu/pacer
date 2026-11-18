import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Ctx } from "../types";
import { activeStrategyText, type UpdateChannel, updateChannel } from "./channel";
import { latestForChannel } from "./manifest";
import { normalizeBase, fetchText, type FetchFn } from "./fetch";
import { compareVersions, currentVersion, isVersion } from "./version";

export interface UpdateCheck { checkedAt: number; latest: string | null; current: string; channel?: UpdateChannel; error?: string }
export const UPDATE_CACHE_S = 86400;
export const UPDATE_TIMEOUT_MS = 3000;
type CheckCtx = Pick<Ctx, "pacerHome" | "env" | "now">;
// Only the top-level scalar is needed here; keep this reader usable in the Node worker too.
export function updateChecksEnabled(ctx: Pick<Ctx, "pacerHome" | "env">): boolean {
  if (ctx.env.PACER_NO_UPDATE_CHECK === "1") return false;
  const text = activeStrategyText(ctx);
  return text === null || !/^update_check:\s*false\s*(?:#.*)?$/m.test(text);
}
export function readUpdateCheck(ctx: Pick<Ctx, "pacerHome" | "env">, current = currentVersion()): UpdateCheck | null {
  if (!updateChecksEnabled(ctx)) return null;
  try {
    const v = JSON.parse(readFileSync(join(ctx.pacerHome, "update-check.json"), "utf8"));
    if (!Number.isFinite(v.checkedAt) || (v.latest !== null && !isVersion(v.latest))) return null;
    // A result computed for the other channel is stale; records without a channel are stable.
    if ((v.channel ?? "stable") !== updateChannel(ctx)) return null;
    return { ...v, current };
  } catch { return null; }
}
export function updateAvailable(check: UpdateCheck | null): boolean {
  return !!check?.latest && isVersion(check.current) && compareVersions(check.latest, check.current) > 0;
}
export function updateLine(check: UpdateCheck | null): string {
  return updateAvailable(check) ? `Update available: pacer ${check!.latest} (you have ${check!.current}). Run: pacer update` : "";
}
export async function checkForUpdate(ctx: CheckCtx, options: { force?: boolean; current?: string; fetch?: FetchFn; base?: string; timeoutMs?: number } = {}): Promise<UpdateCheck | null> {
  if (!updateChecksEnabled(ctx)) return null;
  const current = options.current ?? currentVersion(), cached = readUpdateCheck(ctx, current);
  if (!options.force && cached && ctx.now >= cached.checkedAt && ctx.now - cached.checkedAt < UPDATE_CACHE_S) return cached;
  const channel = updateChannel(ctx);
  const result: UpdateCheck = { checkedAt: ctx.now, latest: cached?.latest ?? null, current, channel };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = options.base ?? ctx.env.PACER_RELEASE_BASE;
    const base = raw ? normalizeBase(raw) : undefined;
    const fetcher: FetchFn = options.fetch ?? (async url => url.startsWith("file://")
      ? new Response(await import("node:fs/promises").then(fs => fs.readFile(fileURLToPath(url))))
      : fetch(url, { signal: controller.signal, redirect: "manual" }));
    // One deadline for the whole check; each feed races it on its own, so a nightly feed that hangs still lets stable answer.
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("update check timed out")); }, options.timeoutMs ?? UPDATE_TIMEOUT_MS); });
    const found = await latestForChannel(channel, base, url => Promise.race([fetchText(fetcher, url), timeout]));
    result.latest = found.latest;
    if (found.error !== undefined) result.error = found.error;
  } catch (e) { result.error = e instanceof Error ? e.message : String(e); }
  finally { clearTimeout(timer); }
  if (!('readOnly' in ctx && ctx.readOnly)) try {
    mkdirSync(ctx.pacerHome, { recursive: true });
    const path = join(ctx.pacerHome, "update-check.json"), temp = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    writeFileSync(temp, JSON.stringify(result) + "\n"); renameSync(temp, path);
  } catch { /* A check must never break the command, even on a read-only home. */ }
  return result;
}
export async function checkUpdateReport(ctx: Ctx, json = false, options: Parameters<typeof checkForUpdate>[1] = {}) {
  const check = await checkForUpdate(ctx, { ...options, force: true });
  const data = { current: options.current ?? currentVersion(), latest: check?.latest ?? null, available: updateAvailable(check), plugin: null, ...(check?.error ? { error: check.error } : {}), ...(!check ? { disabled: true } : {}) };
  return { code: 0, err: "", out: json ? JSON.stringify(data) : [`Current: pacer ${data.current}`, `Latest: ${data.latest ?? "unknown"}`, data.available ? `update available: ${data.current} -> ${data.latest}. Run: pacer update` : check?.error ? `Update check failed: ${check.error}` : !check ? "Update checking disabled" : "No update available"].join("\n") };
}
