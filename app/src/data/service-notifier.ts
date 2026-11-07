/** Renew well inside the 45s lease lapse. */
export const HEARTBEAT_MS = 30_000;
/** First delay after a failed register. Doubles until it matches the heartbeat interval. */
export const REGISTER_RETRY_MS = 1_000;

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
 * The desktop shell owns OS delivery, so `desktop` never registers.
 * `start` resolves after the first register attempt, success or failure, so callers can open
 * the event stream without waiting out retries. Offline is not permanent: attempts continue
 * until a client id exists or `stop` runs, on a later `start` (hello or the stream connecting),
 * when the page becomes visible, and on a backoff from REGISTER_RETRY_MS up to HEARTBEAT_MS.
 * A missed heartbeat keeps the last client id. Only `stop` forgets it.
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
  let stopped = false;
  let timer: { unref?: () => void } | undefined;
  let retryTimer: { unref?: () => void } | undefined;
  let retryDelay = REGISTER_RETRY_MS;
  let attempt: Promise<void> | undefined;
  let removeVisibility: (() => void) | undefined;

  const permission = () => {
    try { return deps.permission?.() ?? browserNotificationPermission(); }
    catch { return "unsupported" as const; }
  };
  const visible = () => {
    try { return deps.visible?.() ?? pageVisible(); }
    catch { return true; }
  };

  function clearRetryTimer() {
    if (!retryTimer) return;
    clock.clearInterval(retryTimer);
    retryTimer = undefined;
  }

  function watchVisibility() {
    if (removeVisibility || deps.desktop) return;
    const doc = (globalThis as { document?: { addEventListener?: (type: string, handler: () => void) => void; removeEventListener?: (type: string, handler: () => void) => void } }).document;
    if (!doc?.addEventListener || !doc.removeEventListener) return;
    const onVisibility = () => { if (!stopped && !clientId && visible()) void start(); };
    doc.addEventListener("visibilitychange", onVisibility);
    removeVisibility = () => doc.removeEventListener!("visibilitychange", onVisibility);
  }

  async function register(): Promise<void> {
    const result = await deps.call("client.register", { kind: "app", version: deps.version, notifier: true });
    if (stopped) return;
    const id = clientIdOf(result);
    if (id) clientId = id;
  }

  function beat(): void {
    if (stopped || !visible() || !clientId) return;
    const id = clientId;
    try {
      void Promise.resolve(deps.call("client.heartbeat", { client_id: id })).catch(() => {
        // Keep the id. A failed renew does not mean this client should drop notices.
      });
    } catch {
      // A thrown heartbeat must not take the page down.
    }
  }

  function armHeartbeat() {
    clearRetryTimer();
    if (timer || stopped || !clientId) return;
    const next = clock.setInterval(beat, HEARTBEAT_MS);
    next.unref?.();
    timer = next;
    if (stopped) clock.clearInterval(next);
  }

  /** One-shot via setInterval so injected clocks can fire the retry without a second timer API. */
  function scheduleRetry() {
    if (stopped || clientId || retryTimer) return;
    const delay = retryDelay;
    let scheduled: { unref?: () => void } | undefined;
    scheduled = clock.setInterval(() => {
      if (scheduled) clock.clearInterval(scheduled);
      if (retryTimer === scheduled) retryTimer = undefined;
      if (stopped || clientId) return;
      retryDelay = Math.min(retryDelay * 2, HEARTBEAT_MS);
      void start();
    }, delay);
    scheduled.unref?.();
    retryTimer = scheduled;
  }

  async function runAttempt(): Promise<void> {
    if (stopped || clientId || deps.desktop) return;
    try {
      await register();
    } catch {
      // Offline and transport errors are not permanent. The next attempt waits for the stream or the backoff.
    }
    if (stopped || deps.desktop) return;
    if (clientId) {
      armHeartbeat();
      return;
    }
    scheduleRetry();
  }

  function start(): Promise<void> {
    if (deps.desktop || stopped || clientId) return Promise.resolve();
    watchVisibility();
    if (attempt) return attempt;
    clearRetryTimer();
    attempt = runAttempt().finally(() => { attempt = undefined; });
    return attempt;
  }

  function stop() {
    stopped = true;
    clientId = undefined;
    if (timer) clock.clearInterval(timer);
    timer = undefined;
    clearRetryTimer();
    removeVisibility?.();
    removeVisibility = undefined;
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
