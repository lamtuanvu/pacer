import { SessionClient, type SessionClientOptions, type SessionState } from './client';
import { platform } from '../platform';
export type ControlIntent = 'watching' | 'driving' | 'released';
export interface SessionRenderer {
  reset(cols: number, rows: number): void;
  write(bytes: Uint8Array): void;
  state?: (state: SessionState) => void;
}
export type SessionConnection = Pick<
  SessionClient,
  | 'state'
  | 'outputOffset'
  | 'connect'
  | 'configure'
  | 'take'
  | 'release'
  | 'focus'
  | 'input'
  | 'resize'
  | 'dispose'
>;
export type ConnectionFactory = (options: SessionClientOptions) => SessionConnection;
type RuntimeOptions = Omit<SessionClientOptions, 'onOutput' | 'onSnapshot' | 'onState'> & {
  live?: boolean;
  attempt?: number | null;
  attemptStartedAt?: number;
};
interface RegistryOptions {
  connection?: ConnectionFactory;
  maxRuntimes?: number;
  maxBytes?: number;
  socket?: SessionClientOptions['socket'];
  schedule?: SessionClientOptions['schedule'];
}
const schedule: NonNullable<SessionClientOptions['schedule']> = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};
type ViewerStorage = Pick<Storage, 'getItem' | 'setItem'> | null;
const WINDOW_LEASE_PREFIX = 'pacer:viewer-lease:';
/** An allocated viewer slot: `n` is the human-readable ordinal, `id` a per-window token that lets us break ties. */
interface ViewerLeaseEntry {
  n: number;
  id: string;
}
/** The short platform name an app window presents to a shared session (ADR 0023, follow-up F6). */
export function viewerPlatformName(desktop: boolean): string {
  return desktop ? 'Pacer desktop' : 'Browser';
}
function readLeases(storage: ViewerStorage, key: string): ViewerLeaseEntry[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(key);
    if (raw == null) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const leases: ViewerLeaseEntry[] = [];
    for (const item of parsed) {
      // Accept both the current {n, id} form and the legacy bare-number array.
      if (Number.isSafeInteger(item) && (item as number) >= 1)
        leases.push({ n: item as number, id: '' });
      else if (
        item &&
        typeof item === 'object' &&
        Number.isSafeInteger((item as ViewerLeaseEntry).n) &&
        (item as ViewerLeaseEntry).n >= 1 &&
        typeof (item as ViewerLeaseEntry).id === 'string'
      )
        leases.push({ n: (item as ViewerLeaseEntry).n, id: (item as ViewerLeaseEntry).id });
    }
    return leases;
  } catch {
    return [];
  }
}
function writeLeases(storage: ViewerStorage, key: string, leases: ViewerLeaseEntry[]): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(leases));
  } catch {
    /* memory-only fallback */
  }
}
/** Short random token; unique per window, used as a tiebreak when two windows land on the same ordinal. */
function windowToken(): string {
  return Math.random().toString(36).slice(2, 6) || 'x';
}
function smallestFreeOrdinal(leases: ViewerLeaseEntry[]): number {
  let n = 1;
  while (leases.some((l) => l.n === n)) n++;
  return n;
}
export interface ViewerWindowLease {
  label: string;
  release(): void;
}
/**
 * Allocates this app window a human-readable viewer label so a shared session's `active` status
 * (last input from …) can tell windows apart (ADR 0023, follow-up F6). The base is the platform
 * name; once more than one window of the same kind is live in this browser profile each gets a
 * short per-window ordinal. Two windows opened in the same instant can both read the same store
 * and pick the same ordinal; each detects the other's same-ordinal lease at its recheck and
 * appends a unique per-window tiebreak so the labels never collide. Release is best-effort and
 * keeps the lease worst-case bounded.
 */
export function announceViewerWindow(desktop: boolean, storage: ViewerStorage): ViewerWindowLease {
  const key = WINDOW_LEASE_PREFIX + (desktop ? 'desktop' : 'browser');
  const id = windowToken();
  const leases = readLeases(storage, key);
  const n = smallestFreeOrdinal(leases);
  const next = [...leases, { n, id }];
  writeLeases(storage, key, next);
  // Re-check the store: if another window grabbed the same ordinal in the same instant, gate the
  // ordinal with my unique token so this window stays distinguishable.
  const after = readLeases(storage, key);
  const collided = after.some((l) => l.n === n && l.id !== id);
  const base = viewerPlatformName(desktop);
  const label = after.length > 1 ? (collided ? `${base} · ${n}·${id}` : `${base} · ${n}`) : base;
  let released = false;
  return {
    label,
    release() {
      if (released) return;
      released = true;
      writeLeases(storage, key, readLeases(storage, key).filter((l) => l.id !== id));
    },
  };
}
function defaultViewerStorage(): ViewerStorage {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
function onPageHide(fn: () => void): void {
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function')
    window.addEventListener('pagehide', fn);
}
let windowLease: ViewerWindowLease | undefined;
/** This app window's viewer label, computed once and shared by all of its terminal panes. */
export function viewerWindowLabel(): string {
  if (!windowLease) {
    windowLease = announceViewerWindow(platform.desktop, defaultViewerStorage());
    onPageHide(() => windowLease?.release());
  }
  return windowLease.label;
}
/** In-memory only. The connection factory can be replaced by a desktop attachment. */
export class SessionRuntime {
  intent: ControlIntent = 'watching';
  takeRequested = false;
  disposed = false;
  client!: SessionConnection;
  state!: SessionState;
  private buffer = new Uint8Array();
  private ringStart = 0;
  private ringLength = 0;
  private renderers = new Set<SessionRenderer>();
  private cancelIdle?: () => void;
  private connected = false;
  private controlVersion = 0;
  private attempt?: number | null;
  private attemptStartedAt?: number;
  constructor(
    readonly target: string,
    private options: RuntimeOptions,
    private maxBytes: number,
    private changed: () => void,
    private later: typeof schedule,
    private connection: ConnectionFactory = (options) => new SessionClient(options),
  ) {
    this.attempt = options.attempt;
    this.attemptStartedAt = options.attemptStartedAt;
    this.create();
  }
  get offset() {
    return this.client.outputOffset;
  }
  get bufferBytes() {
    return this.ringLength;
  }
  get attached() {
    return this.renderers.size > 0;
  }
  get visible() {
    return [...this.visibility.values()].some(Boolean);
  }
  private terminal?: { value: unknown; renderer: SessionRenderer; dispose: () => void };
  private visibility = new Map<SessionRenderer, boolean>();
  ownTerminal<T>(factory: () => { value: T; renderer: SessionRenderer; dispose: () => void }): T {
    if (this.disposed) throw new Error('Disposed terminal runtime');
    if (!this.terminal) {
      this.terminal = factory();
      this.terminal.renderer.reset(this.state.cols, this.state.rows);
      this.terminal.renderer.write(this.replay());
    }
    return this.terminal.value as T;
  }
  setVisible(renderer: SessionRenderer, visible: boolean) {
    if (this.disposed || !this.renderers.has(renderer) || this.visibility.get(renderer) === visible)
      return;
    this.visibility.set(renderer, visible);
    this.changed();
  }
  private sinks() {
    return this.terminal ? [this.terminal.renderer] : this.renderers;
  }
  private create(from?: number) {
    this.client = this.connection({
      ...this.options,
      ...(from !== undefined ? { cols: this.state.cols, rows: this.state.rows } : {}),
      from,
      autoControl: this.intent === 'driving',
      onSnapshot: (s) => {
        this.clearBuffer();
        const bytes = new TextEncoder().encode(s.scrollbackAnsi + s.screenAnsi);
        this.append(bytes);
        for (const r of this.sinks()) {
          r.reset(s.cols, s.rows);
          r.write(bytes);
        }
      },
      onOutput: (b) => {
        this.append(b);
        for (const r of this.sinks()) r.write(b);
      },
      onState: (s) => {
        if (this.intent === 'released' && s.you && !s.shared) {
          this.client.release();
          return;
        }
        const previous = this.state;
        this.state = s;
        // Every pane on a 1.2 host can type, so none of them holds a session like a 1.1 controller.
        if (s.shared) {
          if (this.intent === 'driving') this.intent = 'watching';
        } else {
          if (s.status === 'exited' && this.intent === 'driving') this.intent = 'watching';
          if (s.you && this.intent !== 'released') this.intent = 'driving';
          else if (s.status === 'live' && !s.you && s.controller && this.intent === 'driving')
            this.intent = 'watching';
        }
        this.terminal?.renderer.state?.(s);
        for (const r of this.renderers) r.state?.(s);
        if (
          !previous ||
          Object.keys(s).some(
            (key) => s[key as keyof SessionState] !== previous[key as keyof SessionState],
          )
        )
          this.changed();
        this.idle();
      },
    });
    this.state ??= this.client.state;
  }
  private clearBuffer() {
    this.ringStart = 0;
    this.ringLength = 0;
  }
  private replay() {
    const bytes = new Uint8Array(this.ringLength),
      first = Math.min(this.ringLength, this.maxBytes - this.ringStart);
    bytes.set(this.buffer.subarray(this.ringStart, this.ringStart + first));
    bytes.set(this.buffer.subarray(0, this.ringLength - first), first);
    return bytes;
  }
  private append(bytes: Uint8Array) {
    if (this.buffer.length !== this.maxBytes) this.buffer = new Uint8Array(this.maxBytes);
    if (bytes.length >= this.maxBytes) {
      this.buffer.set(bytes.subarray(bytes.length - this.maxBytes));
      this.ringStart = 0;
      this.ringLength = this.maxBytes;
      return;
    }
    const at = (this.ringStart + this.ringLength) % this.maxBytes,
      first = Math.min(bytes.length, this.maxBytes - at);
    this.buffer.set(bytes.subarray(0, first), at);
    this.buffer.set(bytes.subarray(first), 0);
    this.ringStart =
      (this.ringStart + Math.max(0, this.ringLength + bytes.length - this.maxBytes)) %
      this.maxBytes;
    this.ringLength = Math.min(this.maxBytes, this.ringLength + bytes.length);
  }
  private connect() {
    if (this.disposed || this.connected) return;
    this.connected = true;
    this.client.connect();
  }
  private idle() {
    if (this.renderers.size || this.intent === 'driving') {
      this.cancelIdle?.();
      this.cancelIdle = undefined;
      return;
    }
    if (!this.cancelIdle && this.connected)
      this.cancelIdle = this.later(() => {
        this.cancelIdle = undefined;
        this.client.dispose();
        this.connected = false;
        this.create(this.offset);
      }, 60000);
  }
  attach(renderer: SessionRenderer, view: Partial<RuntimeOptions> = {}) {
    if (this.disposed) return () => {};
    this.cancelIdle?.();
    this.cancelIdle = undefined;
    this.renderers.add(renderer);
    this.visibility.set(renderer, true);
    if (!this.terminal) {
      renderer.reset(this.state.cols, this.state.rows);
      renderer.write(this.replay());
    }
    renderer.state?.(this.state);
    if (!this.connected)
      this.client.configure(
        true,
        this.intent === 'driving' ||
          (this.intent !== 'released' &&
            view.control !== false &&
            view.live !== false &&
            view.autoControl === true),
      );
    this.connect();
    this.changed();
    return () => {
      this.renderers.delete(renderer);
      this.visibility.delete(renderer);
      this.idle();
      this.changed();
    };
  }
  update(options: Partial<RuntimeOptions>) {
    if (this.disposed) return;
    // Compare the known identity pair; missing signals retain their last value.
    // No pending counterpart flag can suppress a later attempt's first signal.
    const nextTime = options.attemptStartedAt ?? this.attemptStartedAt;
    const nextAttempt = options.attempt ?? this.attempt;
    const reset =
      (this.attemptStartedAt !== undefined && nextTime !== this.attemptStartedAt) ||
      (this.attempt != null && nextAttempt !== this.attempt);
    this.attemptStartedAt = nextTime;
    this.attempt = nextAttempt;
    const { control, live, autoControl, ...metadata } = options;
    // A window's viewer label is fixed at connect; only an explicit caller label replaces it.
    const label =
      typeof metadata.label === 'string' && metadata.label ? metadata.label : this.options.label;
    this.options = { ...this.options, ...metadata, label };
    this.client.configure(true, undefined, { url: this.options.url, label });
    if (reset) {
      this.controlVersion++;
      this.clearBuffer();
      for (const r of this.sinks()) r.reset(this.state.cols, this.state.rows);
      if (this.intent !== 'released') this.intent = 'watching';
      this.takeRequested = false;
      this.reconnect(true);
    }
  }
  requestTake() {
    this.takeRequested = true;
    this.changed();
  }
  async take(confirm?: Parameters<SessionClient['take']>[0]) {
    const version = ++this.controlVersion;
    const sent = await this.client.take(
      confirm
        ? async (message) => {
            const allowed = await confirm(message);
            return allowed && version === this.controlVersion;
          }
        : undefined,
    );
    if (version !== this.controlVersion) return false;
    this.takeRequested = false;
    if (sent) this.intent = 'driving';
    this.idle();
    this.changed();
    return sent;
  }
  release() {
    if (this.state.shared) return false;
    this.controlVersion++;
    this.takeRequested = false;
    this.intent = 'released';
    const sent = this.client.release();
    this.idle();
    this.changed();
    return sent;
  }
  focus() {
    return this.client.focus();
  }
  input(text: string) {
    return this.client.input(text);
  }
  resize(cols: number, rows: number) {
    return this.client.resize(cols, rows);
  }
  reconnect(snapshot = false) {
    if (this.disposed) return;
    const offset = snapshot ? undefined : this.offset;
    this.client.dispose();
    this.connected = false;
    this.create(offset);
    this.connect();
  }
  dispose() {
    this.buffer = new Uint8Array();
    this.clearBuffer();
    this.disposed = true;
    this.connected = false;
    this.controlVersion++;
    this.cancelIdle?.();
    this.client.dispose();
    this.renderers.clear();
    this.visibility.clear();
    this.terminal?.dispose();
    this.terminal = undefined;
  }
}
export class SessionRuntimeRegistry {
  private runtimes = new Map<string, SessionRuntime>();
  private released = new Set<string>();
  private listeners = new Set<() => void>();
  constructor(private options: RegistryOptions = {}) {}
  get size() {
    return this.runtimes.size;
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private changed = () => {
    for (const listener of this.listeners) listener();
  };
  peek(service: string, target: string) {
    return this.runtimes.get(JSON.stringify([service, target]));
  }
  get(service: string, target: string, options: RuntimeOptions) {
    const key = JSON.stringify([service, target]);
    let runtime = this.runtimes.get(key);
    if (runtime) {
      runtime.update({ url: options.url });
      this.runtimes.delete(key);
      this.runtimes.set(key, runtime);
      return runtime;
    }
    if (this.size >= (this.options.maxRuntimes ?? 16)) {
      const candidate = [...this.runtimes].find(([, r]) => r.intent !== 'driving' && !r.attached);
      if (!candidate)
        throw new Error(
          'Terminal limit reached. Hide or hand back a session before opening another.',
        );
      candidate[1].dispose();
      this.runtimes.delete(candidate[0]);
    }
    runtime = new SessionRuntime(
      target,
      {
        ...options,
        socket: this.options.socket ?? options.socket,
        schedule: this.options.schedule ?? options.schedule,
      },
      this.options.maxBytes ?? 1024 * 1024,
      () => {
        if (runtime?.intent === 'released') this.released.add(key);
        else if (runtime?.intent === 'driving') this.released.delete(key);
        this.changed();
      },
      this.options.schedule ?? schedule,
      this.options.connection,
    );
    if (this.released.has(key)) {
      runtime.intent = 'released';
      runtime.client.configure(options.control, false);
    }
    this.runtimes.set(key, runtime);
    return runtime;
  }
  updateTasks(service: string, tasks: readonly { id: string; attemptStartedAt?: number }[]) {
    for (const task of tasks)
      this.runtimes
        .get(JSON.stringify([service, `task:${task.id}`]))
        ?.update({ attemptStartedAt: task.attemptStartedAt });
  }
  hiddenDriving() {
    return [...this.runtimes.values()].filter(
      (r) => r.intent === 'driving' && r.state.you && !r.visible,
    );
  }
  dispose() {
    for (const r of this.runtimes.values()) r.dispose();
    this.runtimes.clear();
    this.released.clear();
    this.changed();
  }
}
export const sessionRuntimes = new SessionRuntimeRegistry();
/** Browser service identity is its same-origin service endpoint; target namespaces cannot collide. */
export function sessionRuntime(id: string, url?: string, shell = false, peek = false) {
  const endpoint = new URL(url ?? `/v3/tasks/${encodeURIComponent(id)}/session`, location.href);
  endpoint.protocol = ['https:', 'wss:'].includes(endpoint.protocol) ? 'wss:' : 'ws:';
  if (peek) return sessionRuntimes.peek(endpoint.origin, `${shell ? 'terminal' : 'task'}:${id}`);
  return sessionRuntimes.get(endpoint.origin, `${shell ? 'terminal' : 'task'}:${id}`, {
    url: endpoint.href,
    label: viewerWindowLabel(),
    cols: 120,
    rows: 40,
    control: true,
    autoControl: false,
  });
}

export function browserSessionIdentity() {
  const endpoint = new URL(location.origin);
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
  return endpoint.origin;
}
