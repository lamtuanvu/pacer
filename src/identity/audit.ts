import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { withLockSync } from "../core/lock";
import type { Ctx } from "../types";

/** Host-owned and append-only. Plugins cannot write here: capability.log writes only under logs/plugins. */
export const identityAuditPath = (ctx: Pick<Ctx, "pacerHome">) => join(ctx.pacerHome, "logs", "identity-audit.jsonl");
/** At this size the log moves to `.1`, replacing the previous generation, so it stays under twice this size. */
export const AUDIT_MAX_BYTES = 1024 * 1024;
/** Refused requests logged per plugin per minute; the next one writes one `suppressed` line and the rest are counted. */
export const AUDIT_REFUSALS_PER_MINUTE = 10;

export interface AuditEntry { pluginId: string; purpose: string; payload?: Uint8Array; outcome: "signed" | "refused"; reason?: string; machineId?: string }

const refusals = new Map<string, { start: number; count: number; suppressed: number }>();
/** Wall clock in Unix seconds. The window cannot use ctx.now: a plugin's ctx is built once when the plugin starts. */
let clock = () => Date.now() / 1000;
export function setAuditClockForTests(c?: () => number): void { clock = c ?? (() => Date.now() / 1000); }

/** Record one signature or refused signing request: who asked, for what purpose, and the SHA-256 of the payload, never the payload. */
export function auditSignature(ctx: Pick<Ctx, "pacerHome" | "now">, e: AuditEntry): void {
  let suppressed: number | undefined;
  if (e.outcome === "refused") {
    const key = `${ctx.pacerHome}\0${e.pluginId}`;
    const now = clock();
    let w = refusals.get(key);
    if (!w || now - w.start >= 60) {
      suppressed = w?.suppressed || undefined;
      w = { start: now, count: 0, suppressed: 0 };
      refusals.set(key, w);
    }
    w.count++;
    if (w.count > AUDIT_REFUSALS_PER_MINUTE + 1) { w.suppressed++; return; }
    if (w.count === AUDIT_REFUSALS_PER_MINUTE + 1) {
      w.suppressed++;
      append(ctx, { at: ctx.now, pluginId: e.pluginId, purpose: "", outcome: "suppressed", reason: `more than ${AUDIT_REFUSALS_PER_MINUTE} refused requests in a minute; more refusals from this plugin are not logged until the minute ends` });
      return;
    }
  }
  append(ctx, {
    at: ctx.now, pluginId: e.pluginId, purpose: e.purpose,
    ...(e.payload ? { sha256: createHash("sha256").update(e.payload).digest("hex") } : {}),
    outcome: e.outcome, ...(e.reason ? { reason: e.reason } : {}), ...(e.machineId ? { machineId: e.machineId } : {}),
    // How many refusals the previous minute did not log.
    ...(suppressed ? { suppressed } : {}),
  });
}

function append(ctx: Pick<Ctx, "pacerHome">, line: Record<string, unknown>): void {
  const path = identityAuditPath(ctx);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const full = () => { try { return statSync(path).size >= AUDIT_MAX_BYTES; } catch { return false; /* no log yet */ } };
  // Recheck under the lock: another process may have moved the log already, and renaming its fresh file would drop a generation.
  if (full()) withLockSync(ctx as Ctx, "identity-audit", () => { if (full()) renameSync(path, `${path}.1`); });
  appendFileSync(path, JSON.stringify(line) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}
