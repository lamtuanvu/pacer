import { currentVersion } from "../update/version";

/** Renew well inside the 45s lease lapse. */
export const HEARTBEAT_MS = 30_000;
/** iTerm2 OSC 9 payload, after control characters are removed. */
export const NOTIFY_OSC_MAX = 200;
export const NOTIFY_LINE_MAX = 160;
/**
 * The dashboard event subscription replays the outbox. HTTP replays immediately;
 * the in-process client replays on its first 1s poll. Notifications in this
 * window are treated as replay and are not presented again.
 */
export const HTTP_REPLAY_GRACE_MS = 300;
export const INPROCESS_REPLAY_GRACE_MS = 1500;

export type NotifierCall = (op: string, params?: unknown) => Promise<unknown>;

export interface IntervalClock {
  setInterval(handler: () => void, ms: number): { unref?: () => void };
  clearInterval(timer: { unref?: () => void }): void;
}

const defaultClock: IntervalClock = {
  setInterval(handler, ms) {
    const timer = setInterval(handler, ms);
    return timer;
  },
  clearInterval(timer) {
    clearInterval(timer as ReturnType<typeof setInterval>);
  },
};

export interface NotifySink {
  write(chunk: string): unknown;
}

export interface NotifyEvent {
  type: string;
  seq: number;
  data: unknown;
}

interface Cancel {
  stop(): void;
}

type Schedule = (fn: () => void, ms: number) => Cancel;

export interface TerminalNotifications {
  start(graceMs: number): void;
  event(event: NotifyEvent): void;
  stop(): void;
}

/**
 * Register this dashboard as a terminal delivery client and renew the lease
 * until `stop`. Exit does not unregister; the lease lapses on its own.
 */
export async function registerTuiNotifier(call: NotifierCall, clock: IntervalClock = defaultClock): Promise<{ client_id: string; stop: () => void }> {
  const result = await call("client.register", { kind: "tui", version: currentVersion(), notifier: true });
  const clientId = clientIdOf(result);
  if (!clientId) throw new Error("client.register did not return a client_id");
  const timer = clock.setInterval(() => {
    try {
      void Promise.resolve(call("client.heartbeat", { client_id: clientId })).catch(() => {});
    } catch {
      // A missed heartbeat lapses the lease. The dashboard keeps running.
    }
  }, HEARTBEAT_MS);
  timer.unref?.();
  return { client_id: clientId, stop: () => clock.clearInterval(timer) };
}

/** Present when `recipients` lists this client, or when a legacy event names it and has no recipient list. */
export function shouldPresentNotify(data: unknown, clientId: string): boolean {
  if (!clientId || data === null || typeof data !== "object" || Array.isArray(data)) return false;
  const record = data as { recipients?: unknown; client_id?: unknown };
  if (record.recipients == null) return record.client_id === clientId;
  if (!Array.isArray(record.recipients)) return false;
  return record.recipients.some(id => id === clientId);
}

/** Bell, plus iTerm2 OSC 9 when TERM_PROGRAM or TERM implies the sequence is safe to emit. */
export function presentTerminalNotify(stdout: NotifySink, data: unknown, env: NodeJS.ProcessEnv = process.env): void {
  try {
    let chunk = "\x07";
    if (terminalSupportsOsc9(env)) chunk += `\x1b]9;${oscBody(data)}\x07`;
    stdout.write(chunk);
  } catch {
    // A closed terminal must not take the dashboard down.
  }
}

/** One status-line flash. Control characters are removed so the frame stays intact. */
export function terminalNotifyLine(data: unknown): string {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return "";
  const record = data as { title?: unknown; body?: unknown };
  const title = visible(record.title);
  const body = visible(record.body);
  const line = title && body && body !== title ? `${title}: ${body}` : title || body;
  return clip(line, NOTIFY_LINE_MAX);
}

export function openTerminalNotifications(deps: {
  stdout: NotifySink;
  clientId: () => string | undefined;
  report?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  schedule?: Schedule;
}): TerminalNotifications {
  let armed = false;
  let cursor = -1;
  let timer: Cancel | undefined;
  const schedule = deps.schedule ?? defaultSchedule;
  return {
    start(graceMs) {
      timer?.stop();
      timer = schedule(() => { armed = true; }, graceMs);
    },
    event(event) {
      const seq = event.seq;
      if (!armed) {
        if (seq > cursor) cursor = seq;
        return;
      }
      const clientId = deps.clientId();
      if (event.type === "notify" && seq > cursor && clientId && shouldPresentNotify(event.data, clientId)) {
        presentTerminalNotify(deps.stdout, event.data, deps.env);
        const line = terminalNotifyLine(event.data);
        if (line) deps.report?.(line);
      }
      if (seq > cursor) cursor = seq;
    },
    stop() {
      timer?.stop();
      timer = undefined;
    },
  };
}

function defaultSchedule(fn: () => void, ms: number): Cancel {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return { stop: () => clearTimeout(timer) };
}

function clientIdOf(result: unknown): string | undefined {
  if (result === null || typeof result !== "object") return undefined;
  const id = (result as { client_id?: unknown }).client_id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function terminalSupportsOsc9(env: NodeJS.ProcessEnv): boolean {
  if ((env.TERM_PROGRAM ?? "").length > 0) return true;
  const term = env.TERM ?? "";
  if (term === "" || term === "dumb") return false;
  return /^(?:xterm|screen|tmux|alacritty|kitty|wezterm|ghostty|vscode|rxvt|ansi|cygwin|konsole)/i.test(term);
}

function oscBody(data: unknown): string {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return "pacer";
  const record = data as { title?: unknown; body?: unknown };
  return clip(visible(record.body) || visible(record.title) || "pacer", NOTIFY_OSC_MAX);
}

function visible(value: unknown): string {
  if (typeof value !== "string") return "";
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) continue;
    out += char;
  }
  return out;
}

function clip(text: string, max: number): string {
  let out = "";
  let count = 0;
  for (const char of text) {
    if (count >= max) break;
    out += char;
    count++;
  }
  return out;
}
