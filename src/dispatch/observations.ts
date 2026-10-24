import type { Ctx } from "../types";
import { observationSchema, type Observation, type ObservationMethod, type ObservationScope } from "./types";
import type { Status } from "../engine/status";

export interface ObservationAdapter {
  readonly id: string;
  readonly methods: readonly ObservationMethod[];
  observe(ctx: Ctx, scope: ObservationScope, method: ObservationMethod, signal: AbortSignal): Promise<Observation[]>;
}

const METHODS: ObservationMethod[] = ["models", "capabilities", "usage", "health", "actual-model"];
/** Discard malformed/provider-specific payloads instead of exposing raw errors or credentials. */
export async function collectObservations(ctx: Ctx, adapters: readonly ObservationAdapter[], scopes: readonly ObservationScope[], timeoutMs = 1000): Promise<Observation[]> {
  const groups = await Promise.all(scopes.flatMap(scope => adapters.flatMap(adapter => METHODS.map(async method => {
    const empty = (state: Observation["state"]): Observation[] => [{ source: adapter.id, scope, method, state, observedAt: ctx.now, expiresAt: ctx.now }];
    if (!adapter.methods.includes(method)) return empty("unsupported");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = await Promise.race([
        Promise.resolve().then(() => adapter.observe(ctx, scope, method, controller.signal)),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error("timeout")); }, timeoutMs); }),
      ]);
      if (!Array.isArray(raw) || raw.length > 64) return empty("error");
      const parsed = raw.map(item => observationSchema.safeParse(item));
      if (parsed.some(p => !p.success)) return empty("error");
      return parsed.flatMap(p => {
        if (!p.success) return [];
        const o = p.data;
        if (o.source !== adapter.id || o.method !== method || o.scope.runner !== scope.runner || o.scope.account !== scope.account || JSON.stringify(o.scope.binding) !== JSON.stringify(scope.binding) || o.observedAt > ctx.now || o.expiresAt < o.observedAt) return empty("error");
        return [{ ...o, ...(o.expiresAt <= ctx.now && o.state === "known" ? { state: "unknown" as const, value: undefined } : {}) }];
      });
    } catch { return empty("error"); }
    finally { if (timer) clearTimeout(timer); controller.abort(); }
  }))));
  return groups.flat();
}

/** Wrap the existing cache-only status reader; never refresh timestamps when reading a cache. */
export function statusObservationAdapter(status: Status): ObservationAdapter {
  return {
    id: "status-cache", methods: ["health", "usage"],
    async observe(ctx, scope, method) {
      const provider = status.providers.find(p => p.id === scope.runner);
      const account = status.accounts?.find(a => a.name === scope.account);
      const observedAt = account?.capturedAt ?? status.generatedAt;
      const expiresAt = Math.min(observedAt + 60, ...((provider?.windows ?? []).flatMap(w => w.resetsAt === null ? [] : [w.resetsAt])));
      const base = { source: "status-cache", scope, method, observedAt, expiresAt };
      if (!provider || provider.stale || account?.stale) return [{ ...base, state: "unknown" }];
      if (method === "health") return [{ ...base, state: "known", value: { healthy: provider.installed && !provider.unavailableReason && !provider.signedOutReason && !provider.blockedReason && !provider.brokenReason && provider.eligibility?.state !== "ineligible" } }];
      const windows = provider.windows.filter(w => !w.stale && !w.rolled && w.usedPct !== null).map(w => ({
        pool: JSON.stringify([scope.account, w.name]), usedPct: w.usedPct!,
        ...(w.resetsAt !== null && w.resetsAt > ctx.now ? { hoursLeft: (w.resetsAt - ctx.now) / 3600 } : {}),
      }));
      const complete = windows.length > 0 && windows.length === provider.windows.length && account?.capturedAt != null;
      if (provider.usage !== "unmetered" && !complete) return [{ ...base, state: "unknown" }];
      return [{ ...base, state: "known", value: { windows, unmetered: provider.usage === "unmetered" } }];
    },
  };
}
