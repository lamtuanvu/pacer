export interface Model { id: string; name?: string; context?: number; output?: number; tools?: boolean }
export interface Account {
  name: string; kind: string; folder?: string; source?: string; signedIn?: boolean | null; signin_command?: string; runners?: string[];
  state?: string | { state?: string; detail?: string }; detail?: string;
  connection?: { base_url_host?: string; key?: string; models: Model[]; checked_at?: string | number };
  usageReading?: { windows: { name: string; usedPct: number | null; resetsAt: number | null }[]; capturedAt?: number | null; stale?: boolean; source?: string };
}
export interface Limit { account: string; capturedAt?: number | null; stale?: boolean; source?: string | null; usedPct?: number | null; window?: string | null; resetsAt?: number | null; error?: string | null; hint?: string | null }
export const clock = (seconds: number) => new Date(seconds * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
export function accountsModel(accounts: Account[], limits: Limit[]) {
  return accounts.map(account => {
    const limit = limits.find(l => l.account === account.name);
    const captured = limit?.capturedAt ?? account.usageReading?.capturedAt;
    const stale = limit?.stale ?? account.usageReading?.stale;
    return { ...account, signin: account.kind === "endpoint" || account.signedIn === true ? undefined : signinCommand(account),
      windows: account.usageReading?.windows.length ? account.usageReading.windows : limit?.window ? [{ name: limit.window, usedPct: limit.usedPct ?? null, resetsAt: limit.resetsAt ?? null }] : [],
      freshness: captured == null ? "Usage not available yet" : `${stale ? "Stale since" : "Updated"} ${clock(captured)}`,
      source: limit?.source ?? account.usageReading?.source ?? "Unknown source", error: limit?.error, hint: limit?.hint ? limit.hint[0]!.toUpperCase() + limit.hint.slice(1) : limit?.hint };
  });
}

function signinCommand(account: Account): string | undefined {
  const folder = account.folder?.replace(/\/$/, "");
  if (account.kind === "claude" && folder?.endsWith("/.claude")) return "claude\n# Then run /login to sign in.";
  if (account.kind === "codex" && folder?.endsWith("/.codex")) return "codex login";
  return account.signin_command;
}
