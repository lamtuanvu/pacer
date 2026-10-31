import type { AccountSummary } from "../../../src/api/read-model/types";
/** Budget reads follow their own configuration, not update/plugin/control traffic. */
export function budgetResourceRevision(op: string, invalidations: Record<string, number>, accounts?: readonly AccountSummary[]): string | undefined {
  if (op !== 'account.list' && op !== 'routing.status') return undefined;
  const areas = op === 'account.list' ? ['accounts', 'config', 'setup', 'strategy', 'runners', 'usage']
    : ['accounts', 'config', 'setup', 'strategy', 'runners', 'usage', 'mode', 'hosts', 'project-strategies'];
  return JSON.stringify([areas.map(area => invalidations[area] ?? 0), accounts?.map(account => [account.name, account.capturedAt, account.usedPct, account.resetsAt, account.stale, account.signedIn])]);
}
