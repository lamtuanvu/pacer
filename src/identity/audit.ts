import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Ctx } from "../types";

/** Host-owned and append-only. Plugins cannot write here: capability.log writes only under logs/plugins. */
export const identityAuditPath = (ctx: Pick<Ctx, "pacerHome">) => join(ctx.pacerHome, "logs", "identity-audit.jsonl");

export interface AuditEntry { pluginId: string; purpose: string; payload?: Uint8Array; outcome: "signed" | "refused"; reason?: string; machineId?: string }

/** Record one signature or refused signing request: who asked, for what purpose, and the SHA-256 of the payload, never the payload. */
export function auditSignature(ctx: Pick<Ctx, "pacerHome" | "now">, e: AuditEntry): void {
  const path = identityAuditPath(ctx);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const line = {
    at: ctx.now, pluginId: e.pluginId, purpose: e.purpose,
    ...(e.payload ? { sha256: createHash("sha256").update(e.payload).digest("hex") } : {}),
    outcome: e.outcome, ...(e.reason ? { reason: e.reason } : {}), ...(e.machineId ? { machineId: e.machineId } : {}),
  };
  appendFileSync(path, JSON.stringify(line) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}
