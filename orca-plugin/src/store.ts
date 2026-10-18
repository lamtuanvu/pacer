import { contentKey, emptySnapshot, reduce, type Envelope } from "../../src/link/envelope";
import type { ClientSnapshot } from "../../src/view-model/snapshot";
import type { TransportId } from "./transports/choose";
/** Ignore heartbeat-only updates, but observe every field the status page renders. */
const snapshotKey = (s: ClientSnapshot): string => s.planner === undefined ? contentKey(s) : JSON.stringify({
 planner:s.planner, executors:s.executors, accounts:s.accounts, service:s.service,
 setup:s.setup, attention:s.attention, mode:s.mode, strategies:s.strategies, tasks:s.tasks,
});
export class LinkStore {
  snapshot: ClientSnapshot = emptySnapshot();
  transport: TransportId | null = null;
  private listeners: ((s: ClientSnapshot) => void)[] = [];
  constructor(private nowS: () => number) {}
  apply(e: Envelope): void { this.replace(reduce(this.snapshot, e, this.nowS())); }
  replace(s: ClientSnapshot): void {
    const changed = snapshotKey(s) !== snapshotKey(this.snapshot); this.snapshot = s;
    if (changed) for (const fn of this.listeners) fn(s);
  }
  onChange(fn: (s: ClientSnapshot) => void): void { this.listeners.push(fn); }
}
