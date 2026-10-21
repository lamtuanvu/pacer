export interface Notification {
  id: string;
  key: string;
  tone: 'success' | 'warning' | 'error' | 'info';
  title: string;
  message?: string;
}
interface Clock {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (timer: number) => void;
}
export function createNotifications(clock: Clock = {now: Date.now, setTimer: (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number, clearTimer: timer => globalThis.clearTimeout(timer)}) {
  let items: Notification[] = [], next = 0;
  const listeners = new Set<() => void>();
  const timers = new Map<string, {timer?: number; remaining: number; start: number; paused: boolean}>();
  const emit = () => { for (const listener of listeners) listener(); };
  const stop = (id: string) => {
    const t = timers.get(id);
    if (t?.timer !== undefined) { clock.clearTimer(t.timer); t.timer = undefined; t.remaining = Math.max(0, t.remaining - clock.now() + t.start); }
  };
  const sync = () => {
    for (const [id] of timers) if (!items.slice(0,3).some(n => n.id === id)) stop(id);
    for (const n of items.slice(0,3)) {
      const t = timers.get(n.id);
      if (t && !t.paused && t.timer === undefined) { t.start = clock.now(); t.timer = clock.setTimer(() => dismiss(n.id), t.remaining); }
    }
  };
  const dismiss = (id: string) => {
    stop(id); timers.delete(id); items = items.filter(n => n.id !== id); sync(); emit();
  };
  return {
    notify(input: Omit<Notification, 'id'>): string {
      const old = items.find(n => n.key === input.key);
      if (old) { stop(old.id); timers.delete(old.id); }
      const id = old?.id ?? String(++next), notification = {...input, id};
      items = old ? items.map(n => n.id === id ? notification : n) : [...items, notification];
      // Bound queued feedback too; persistent failures are not displaced by polling (which never notifies).
      if (items.length > 30) { const removed = items.pop()!; timers.delete(removed.id); }
      if (input.tone === 'success' || input.tone === 'info') timers.set(id, {remaining:5000, start:clock.now(), paused:false});
      sync(); emit(); return id;
    },
    dismiss, pause(id: string) { const t=timers.get(id); if(t)t.paused=true; stop(id); },
    resume(id: string) { const t=timers.get(id); if(t)t.paused=false; sync(); },
    getSnapshot: () => items.slice(0,3),
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() { for (const [id] of timers) stop(id); timers.clear(); items=[]; emit(); listeners.clear(); },
  };
}
export type Notifications = ReturnType<typeof createNotifications>;
