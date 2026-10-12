import { contentKey, emptySnapshot, reduce, type Envelope, type LinkSnapshot } from "../../src/link/envelope";
import type { TransportId } from "./transports/choose";
export class LinkStore {
  snapshot: LinkSnapshot = emptySnapshot();
  transport: TransportId | null = null;
  private listeners: ((s: LinkSnapshot) => void)[] = [];
  constructor(private nowS: () => number) {}
  apply(e: Envelope): void { this.replace(reduce(this.snapshot, e, this.nowS())); }
  replace(s: LinkSnapshot): void {
    const changed = contentKey(s) !== contentKey(this.snapshot); this.snapshot = s;
    if (changed) for (const fn of this.listeners) fn(s);
  }
  onChange(fn: (s: LinkSnapshot) => void): void { this.listeners.push(fn); }
}
