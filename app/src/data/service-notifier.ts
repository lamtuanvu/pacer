/** Renew well inside the 45s lease lapse. */
export const HEARTBEAT_MS = 30_000;

export type NotifierCall = (op: string, params?: unknown) => Promise<unknown>;
export type BrowserPermission = NotificationPermission | "unsupported";

export interface IntervalClock {
  setInterval(handler: () => void, ms: number): { unref?: () => void };
  clearInterval(timer: { unref?: () => void }): void;
}

const nativeSetInterval = globalThis.setInterval.bind(globalThis);
const nativeClearInterval = globalThis.clearInterval.bind(globalThis);
const defaultClock: IntervalClock = {
  setInterval(handler, ms) {
    const timer = nativeSetInterval(handler, ms);
    return timer;
  },
  clearInterval(timer) {
    nativeClearInterval(timer as ReturnType<typeof setInterval>);
  },
};

export interface ServiceNotifier {
  start(): Promise<void>;
  stop(): void;
  event(event: { type: string; data: unknown }): void;
}

/** Present when `recipients` lists this client, or when a legacy event names it and has no recipient list. */
export function shouldPresentNotify(data: unknown, clientId: string): boolean {
  if (!clientId || data === null || typeof data !== "object" || Array.isArray(data)) return false;
  const record = data as { recipients?: unknown; client_id?: unknown };
  if (record.recipients == null) return record.client_id === clientId;
  if (!Array.isArray(record.recipients)) return false;
  return record.recipients.some(id => id === clientId);
}

export function browserNotificationPermission(): BrowserPermission {
  try {
    const notification = (globalThis as { Notification?: { permission?: NotificationPermission } }).Notification;
    const permission = notification?.permission;
    if (permission !== "granted" && permission !== "denied" && permission !== "default") return "unsupported";
    return permission;
  } catch {
    return "unsupported";
  }
}

/** Settings shows this once the user wants notifications and the browser has not granted them. */
export function showBrowserNotificationOffer(level: string, desktop: boolean, permission: BrowserPermission = browserNotificationPermission()): boolean {
  return !desktop && (level === "important" || level === "all") && permission !== "granted" && permission !== "unsupported";
}

export function requestBrowserNotificationPermission(): Promise<BrowserPermission> {
  try {
    const notification = (globalThis as { Notification?: { requestPermission?: () => Promise<NotificationPermission> } }).Notification;
    if (!notification || typeof notification.requestPermission !== "function") return Promise.resolve("unsupported");
    return Promise.resolve(notification.requestPermission()).then(permission => permission === "granted" || permission === "denied" || permission === "default" ? permission : "unsupported").catch(() => browserNotificationPermission());
  } catch {
    return Promise.resolve("unsupported");
  }
}

function pageVisible(): boolean {
  try {
    return (globalThis as { document?: { visibilityState?: string } }).document?.visibilityState !== "hidden";
  } catch {
    return true;
  }
}

/**
 * Register this browser tab as a delivery client and present notify events addressed to it.
 * The desktop shell owns OS delivery, so `desktop` never registers. A missed heartbeat lapses the lease.
 */
export function createServiceNotifier(deps: {
  call: NotifierCall;
  notify: (title: string, options?: NotificationOptions) => Promise<boolean>;
  desktop: boolean;
  version: string;
  permission?: () => BrowserPermission;
  visible?: () => boolean;
  clock?: IntervalClock;
}): ServiceNotifier {
  const clock = deps.clock ?? defaultClock;
  let clientId: string | undefined;
  let started = false;
  let stopped = false;
  let timer: { unref?: () => void } | undefined;

  const permission = () => {
    try { return deps.permission?.() ?? browserNotificationPermission(); }
    catch { return "unsupported" as const; }
  };
  const visible = () => {
    try { return deps.visible?.() ?? pageVisible(); }
    catch { return true; }
  };

  async function register(): Promise<void> {
    const result = await deps.call("client.register", { kind: "app", version: deps.version, notifier: true });
    if (stopped) return;
    const id = clientIdOf(result);
    if (id) clientId = id;
  }

  function beat(): void {
    if (stopped || !visible()) return;
    if (!clientId) {
      void register().catch(() => {});
      return;
    }
    const id = clientId;
    try {
      void Promise.resolve(deps.call("client.heartbeat", { client_id: id })).catch(() => {
        if (clientId === id) clientId = undefined;
      });
    } catch {
      if (clientId === id) clientId = undefined;
    }
  }

  async function start(): Promise<void> {
    if (deps.desktop || started || stopped) return;
    started = true;
    try {
      await register();
      if (stopped) return;
      if (!clientId) { started = false; return; }
      const next = clock.setInterval(beat, HEARTBEAT_MS);
      next.unref?.();
      timer = next;
      if (stopped) clock.clearInterval(next);
    } catch {
      if (!stopped) started = false;
    }
  }

  function stop() {
    stopped = true;
    clientId = undefined;
    if (timer) clock.clearInterval(timer);
    timer = undefined;
  }

  function event(event: { type: string; data: unknown }) {
    if (deps.desktop || stopped || event.type !== "notify" || !clientId || !shouldPresentNotify(event.data, clientId)) return;
    if (permission() !== "granted") return;
    const record = event.data !== null && typeof event.data === "object" && !Array.isArray(event.data) ? event.data as { title?: unknown; body?: unknown } : {};
    const title = typeof record.title === "string" && record.title.trim() ? record.title : "pacer";
    const body = typeof record.body === "string" ? record.body : "";
    try {
      void Promise.resolve(deps.notify(title, { body })).catch(() => {});
    } catch {
      // A rejected notification must not take the page down.
    }
  }

  return { start, stop, event };
}

function clientIdOf(result: unknown): string | undefined {
  if (result === null || typeof result !== "object") return undefined;
  const id = (result as { client_id?: unknown }).client_id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}
