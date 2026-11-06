import { expect, test } from "bun:test";
import { h, options } from "preact";
import { renderToString } from "preact-render-to-string";
import { emptySnapshot } from "../src/link/envelope";
import { platform } from "../app/src/platform";
import type { BrowserApi } from "../app/src/data/api";
import { createStore, initialState } from "../app/src/data/store";
import { TaskContext } from "../app/src/screens/task-shared";
import { SettingsGeneral } from "../app/src/screens/settings/General";
import { settings } from "./fixtures/ui/settings";
import {
  HEARTBEAT_MS,
  REGISTER_RETRY_MS,
  createServiceNotifier,
  showBrowserNotificationOffer,
  type IntervalClock,
} from "../app/src/data/service-notifier";

const mine = "client-mine";

test("showBrowserNotificationOffer is the settings permission affordance", () => {
  expect(showBrowserNotificationOffer("important", false, "default")).toBe(true);
  expect(showBrowserNotificationOffer("all", false, "denied")).toBe(true);
  expect(showBrowserNotificationOffer("off", false, "default")).toBe(false);
  expect(showBrowserNotificationOffer("important", true, "default")).toBe(false);
  expect(showBrowserNotificationOffer("important", false, "granted")).toBe(false);
  expect(showBrowserNotificationOffer("important", false, "unsupported")).toBe(false);
});

test("browser notifier registers, heartbeats, and stops", async () => {
  const calls: { op: string; params?: unknown }[] = [];
  let beat: (() => void) | undefined;
  let delay = 0;
  let timer: { unref?: () => void } | undefined;
  const cleared: unknown[] = [];
  const clock: IntervalClock = {
    setInterval(handler, ms) {
      beat = handler;
      delay = ms;
      timer = { unref() {} };
      return timer;
    },
    clearInterval(value) { cleared.push(value); },
  };
  const notifier = createServiceNotifier({
    desktop: false,
    version: "1.2.3",
    clock,
    visible: () => true,
    permission: () => "granted",
    notify: async () => true,
    call: async (op, params) => {
      calls.push({ op, params });
      if (op === "client.heartbeat") throw new Error("down");
      return { client_id: mine, lease_s: 45 };
    },
  });
  await notifier.start();
  expect(calls).toEqual([{ op: "client.register", params: { kind: "app", version: "1.2.3", notifier: true } }]);
  expect(delay).toBe(HEARTBEAT_MS);
  expect(() => beat!()).not.toThrow();
  await Promise.resolve();
  await Promise.resolve();
  expect(calls[1]).toEqual({ op: "client.heartbeat", params: { client_id: mine } });
  beat!();
  await Promise.resolve();
  await Promise.resolve();
  expect(calls[2]).toEqual({ op: "client.heartbeat", params: { client_id: mine } });
  notifier.stop();
  expect(cleared).toEqual([timer]);
  beat!();
  await Promise.resolve();
  expect(calls.filter(call => call.op === "client.heartbeat")).toHaveLength(2);
  await notifier.start();
  expect(calls.filter(call => call.op === "client.register")).toHaveLength(1);
});

test("an offline register retries until the client id is set", async () => {
  const calls: { op: string; params?: unknown }[] = [];
  const notes: string[] = [];
  const scheduled: { handler: () => void; ms: number }[] = [];
  let online = false;
  const notifier = createServiceNotifier({
    desktop: false,
    version: "1.2.3",
    permission: () => "granted",
    visible: () => true,
    notify: async title => { notes.push(title); return true; },
    clock: {
      setInterval(handler, ms) { scheduled.push({ handler, ms }); return { unref() {} }; },
      clearInterval() {},
    },
    call: async (op, params) => {
      calls.push({ op, params });
      if (!online) throw new Error("offline");
      return op === "client.register" ? { client_id: mine, lease_s: 45 } : { ok: true };
    },
  });
  await notifier.start();
  expect(calls).toEqual([{ op: "client.register", params: { kind: "app", version: "1.2.3", notifier: true } }]);
  expect(scheduled.map(item => item.ms)).toEqual([REGISTER_RETRY_MS]);
  notifier.event({ type: "notify", data: { recipients: [mine], title: "Early", body: "no" } });
  expect(notes).toEqual([]);
  scheduled[0]!.handler();
  await flush();
  expect(calls).toHaveLength(2);
  expect(scheduled.map(item => item.ms)).toEqual([REGISTER_RETRY_MS, REGISTER_RETRY_MS * 2]);
  online = true;
  scheduled[1]!.handler();
  await flush();
  expect(calls[2]).toEqual({ op: "client.register", params: { kind: "app", version: "1.2.3", notifier: true } });
  expect(scheduled.map(item => item.ms)).toEqual([REGISTER_RETRY_MS, REGISTER_RETRY_MS * 2, HEARTBEAT_MS]);
  notifier.event({ type: "notify", data: { recipients: [mine], title: "Later", body: "yes" } });
  expect(notes).toEqual(["Later"]);
  notifier.stop();
});

test("a visible page retries register without waiting out the backoff", async () => {
  const calls: string[] = [];
  const notes: string[] = [];
  const listeners = new Set<() => void>();
  let visible = false;
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      visibilityState: "hidden",
      addEventListener(_type: string, handler: () => void) { listeners.add(handler); },
      removeEventListener(_type: string, handler: () => void) { listeners.delete(handler); },
    },
  });
  const notifier = createServiceNotifier({
    desktop: false,
    version: "1.2.3",
    permission: () => "granted",
    visible: () => visible,
    notify: async title => { notes.push(title); return true; },
    clock: { setInterval() { return {}; }, clearInterval() {} },
    call: async () => {
      calls.push("client.register");
      if (calls.length === 1) throw new Error("offline");
      return { client_id: mine };
    },
  });
  try {
    await notifier.start();
    expect(calls).toEqual(["client.register"]);
    expect(listeners.size).toBe(1);
    visible = true;
    for (const listener of listeners) listener();
    await flush();
    expect(calls).toEqual(["client.register", "client.register"]);
    notifier.event({ type: "notify", data: { recipients: [mine], title: "Seen", body: "y" } });
    expect(notes).toEqual(["Seen"]);
    notifier.stop();
    expect(listeners.size).toBe(0);
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("desktop notifier does not register", async () => {
  const calls: string[] = [];
  const notes: string[] = [];
  const notifier = createServiceNotifier({
    desktop: true,
    version: "1.2.3",
    notify: async title => { notes.push(title); return true; },
    call: async op => { calls.push(op); return { client_id: mine }; },
  });
  await notifier.start();
  notifier.event({ type: "notify", data: { client_id: mine, title: "Ready", body: "Detail" } });
  expect(calls).toEqual([]);
  expect(notes).toEqual([]);
});

test("a hidden page skips the heartbeat", async () => {
  const calls: string[] = [];
  let beat: (() => void) | undefined;
  const notifier = createServiceNotifier({
    desktop: false,
    version: "1.2.3",
    visible: () => false,
    permission: () => "granted",
    notify: async () => true,
    clock: {
      setInterval(handler) { beat = handler; return {}; },
      clearInterval() {},
    },
    call: async op => { calls.push(op); return { client_id: mine }; },
  });
  await notifier.start();
  beat!();
  await Promise.resolve();
  expect(calls).toEqual(["client.register"]);
});

test("a failed heartbeat keeps the client id and still presents", async () => {
  const calls: string[] = [];
  const notes: string[] = [];
  let beat: (() => void) | undefined;
  const notifier = createServiceNotifier({
    desktop: false,
    version: "1.2.3",
    permission: () => "granted",
    visible: () => true,
    clock: { setInterval(handler) { beat = handler; return {}; }, clearInterval() {} },
    notify: async title => { notes.push(title); return true; },
    call: async op => {
      calls.push(op);
      if (op === "client.heartbeat") throw new Error("down");
      return { client_id: mine };
    },
  });
  await notifier.start();
  beat!();
  await Promise.resolve();
  notifier.event({ type: "notify", data: { recipients: [mine], title: "Still", body: "Here" } });
  expect(notes).toEqual(["Still"]);
  expect(calls).toEqual(["client.register", "client.heartbeat"]);
});

test("notify events present only for this client when permission is granted", async () => {
  const notes: { title: string; body?: string }[] = [];
  let permission: NotificationPermission | "unsupported" = "granted";
  const notifier = createServiceNotifier({
    desktop: false,
    version: "1.2.3",
    permission: () => permission,
    notify: async (title, options) => { notes.push({ title, body: options?.body }); return true; },
    call: async () => ({ client_id: mine }),
  });
  await notifier.start();
  notifier.event({ type: "task", data: { client_id: mine, title: "Task", body: "x" } });
  notifier.event({ type: "notify", data: { recipients: ["other"], client_id: mine, title: "Nope", body: "x" } });
  notifier.event({ type: "notify", data: { recipients: [mine], client_id: "primary", title: "Ready", body: "Detail" } });
  notifier.event({ type: "notify", data: { client_id: mine, title: "Legacy", body: "Old" } });
  notifier.event({ type: "notify", data: { recipients: null, client_id: mine, title: "Null", body: "List" } });
  permission = "default";
  notifier.event({ type: "notify", data: { recipients: [mine], title: "Blocked", body: "no" } });
  expect(notes).toEqual([
    { title: "Ready", body: "Detail" },
    { title: "Legacy", body: "Old" },
    { title: "Null", body: "List" },
  ]);
});

class FakeEvents {
  static instances: FakeEvents[] = [];
  listeners: Record<string, (event: { data: string; lastEventId: string }) => void> = {};
  constructor(readonly url: string) { FakeEvents.instances.push(this); }
  addEventListener(type: string, callback: (event: { data: string; lastEventId: string }) => void) { this.listeners[type] = callback; }
  close() {}
  emit(type: string, data: unknown, seq: string) { this.listeners[type]?.({ data: JSON.stringify(data), lastEventId: seq }); }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const host = globalThis as { __TAURI__?: { core: { invoke: (command: string) => Promise<unknown> } } };

test("the browser store registers after hello and presents this client's notifications", async () => {
  const previousTauri = host.__TAURI__;
  const previousNotification = Object.getOwnPropertyDescriptor(globalThis, "Notification");
  delete host.__TAURI__;
  expect(platform.desktop).toBe(false);
  const shown: { title: string; options?: NotificationOptions }[] = [];
  class FakeNotification {
    static permission: NotificationPermission = "granted";
    constructor(title: string, options?: NotificationOptions) { shown.push({ title, options }); }
  }
  Object.defineProperty(globalThis, "Notification", { configurable: true, writable: true, value: FakeNotification });
  FakeEvents.instances = [];
  const calls: { op: string; params?: unknown }[] = [];
  const api = {
    hello: async () => ({ protocol: "3.0.0", pacer: "1.2.3", ops: ["client.register"], events: ["notify", "attention"] }),
    snapshot: async () => ({ protocol: "3.0.0", seq: 5, snapshot: { ...emptySnapshot(), seq: 5 } }),
    call: async (op: string, params?: unknown) => {
      calls.push({ op, params });
      return op === "client.register" ? { client_id: mine, lease_s: 45 } : { ok: true };
    },
  };
  const store = createStore(api as BrowserApi, FakeEvents as unknown as typeof EventSource);
  const stop = store.start();
  try {
    await flush();
    expect(calls).toEqual([{ op: "client.register", params: { kind: "app", version: "1.2.3", notifier: true } }]);
    const stream = FakeEvents.instances[0]!;
    stream.emit("notify", { recipients: [mine], client_id: "primary", title: "Ready", body: "Detail" }, "6");
    stream.emit("notify", { recipients: ["other"], client_id: mine, title: "Nope", body: "Elsewhere" }, "7");
    expect(shown).toEqual([{ title: "Ready", options: { body: "Detail" } }]);
    expect(store.getState().snapshot?.seq).toBe(7);
  } finally {
    stop();
    if (previousNotification) Object.defineProperty(globalThis, "Notification", previousNotification);
    else Reflect.deleteProperty(globalThis, "Notification");
    if (previousTauri) host.__TAURI__ = previousTauri;
    else delete host.__TAURI__;
    expect(platform.desktop).toBe(!!host.__TAURI__);
  }
});

test("the browser store opens the event stream only after register resolves", async () => {
  const previousTauri = host.__TAURI__;
  const previousNotification = Object.getOwnPropertyDescriptor(globalThis, "Notification");
  delete host.__TAURI__;
  expect(platform.desktop).toBe(false);
  const shown: { title: string; options?: NotificationOptions }[] = [];
  class FakeNotification {
    static permission: NotificationPermission = "granted";
    constructor(title: string, options?: NotificationOptions) { shown.push({ title, options }); }
  }
  Object.defineProperty(globalThis, "Notification", { configurable: true, writable: true, value: FakeNotification });
  FakeEvents.instances = [];
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const api = {
    hello: async () => ({ protocol: "3.0.0", pacer: "1.2.3", ops: ["client.register"], events: ["notify", "attention"] }),
    snapshot: async () => ({ protocol: "3.0.0", seq: 5, snapshot: { ...emptySnapshot(), seq: 5 } }),
    call: async (op: string) => {
      calls.push(op);
      if (op === "client.register") { await gate; return { client_id: mine, lease_s: 45 }; }
      return { ok: true };
    },
  };
  const store = createStore(api as BrowserApi, FakeEvents as unknown as typeof EventSource);
  const stop = store.start();
  try {
    await flush();
    expect(calls).toEqual(["client.register"]);
    expect(FakeEvents.instances).toHaveLength(0);
    expect(store.getState().snapshot?.seq).toBe(5);
    release();
    await flush();
    expect(FakeEvents.instances).toHaveLength(1);
    FakeEvents.instances[0]!.emit("notify", { recipients: [mine], client_id: "primary", title: "Ready", body: "Detail" }, "6");
    expect(shown).toEqual([{ title: "Ready", options: { body: "Detail" } }]);
  } finally {
    stop();
    if (previousNotification) Object.defineProperty(globalThis, "Notification", previousNotification);
    else Reflect.deleteProperty(globalThis, "Notification");
    if (previousTauri) host.__TAURI__ = previousTauri;
    else delete host.__TAURI__;
    expect(platform.desktop).toBe(!!host.__TAURI__);
  }
});

test("the browser store opens the stream when the first register is offline, then registers once connected", async () => {
  const previousTauri = host.__TAURI__;
  const previousNotification = Object.getOwnPropertyDescriptor(globalThis, "Notification");
  delete host.__TAURI__;
  expect(platform.desktop).toBe(false);
  const shown: { title: string; options?: NotificationOptions }[] = [];
  class FakeNotification {
    static permission: NotificationPermission = "granted";
    constructor(title: string, options?: NotificationOptions) { shown.push({ title, options }); }
  }
  Object.defineProperty(globalThis, "Notification", { configurable: true, writable: true, value: FakeNotification });
  FakeEvents.instances = [];
  let offline = true;
  const calls: string[] = [];
  const api = {
    hello: async () => ({ protocol: "3.0.0", pacer: "1.2.3", ops: ["client.register"], events: ["notify", "attention"] }),
    snapshot: async () => ({ protocol: "3.0.0", seq: 5, snapshot: { ...emptySnapshot(), seq: 5 } }),
    setConnected(value: boolean) { if (value) offline = false; },
    call: async (op: string) => {
      calls.push(op);
      if (op === "client.register" && offline) throw new Error("offline");
      return op === "client.register" ? { client_id: mine, lease_s: 45 } : { ok: true };
    },
  };
  const store = createStore(api as BrowserApi, FakeEvents as unknown as typeof EventSource);
  const stop = store.start();
  try {
    await flush();
    expect(calls).toEqual(["client.register"]);
    expect(FakeEvents.instances).toHaveLength(1);
    expect(shown).toEqual([]);
    FakeEvents.instances[0]!.emit("open", {}, "0");
    await flush();
    expect(calls).toEqual(["client.register", "client.register"]);
    FakeEvents.instances[0]!.emit("notify", { recipients: [mine], client_id: "primary", title: "Ready", body: "Detail" }, "6");
    expect(shown).toEqual([{ title: "Ready", options: { body: "Detail" } }]);
  } finally {
    stop();
    if (previousNotification) Object.defineProperty(globalThis, "Notification", previousNotification);
    else Reflect.deleteProperty(globalThis, "Notification");
    if (previousTauri) host.__TAURI__ = previousTauri;
    else delete host.__TAURI__;
    expect(platform.desktop).toBe(!!host.__TAURI__);
  }
});

test("the desktop store does not register a browser notifier", async () => {
  const previousTauri = host.__TAURI__;
  host.__TAURI__ = { core: { invoke: async () => true } };
  expect(platform.desktop).toBe(true);
  FakeEvents.instances = [];
  const calls: string[] = [];
  const api = {
    hello: async () => ({ protocol: "3.0.0", pacer: "1.2.3", ops: ["client.register"], events: ["notify"] }),
    snapshot: async () => ({ protocol: "3.0.0", seq: 5, snapshot: { ...emptySnapshot(), seq: 5 } }),
    call: async (op: string) => { calls.push(op); return { client_id: mine }; },
  };
  const store = createStore(api as BrowserApi, FakeEvents as unknown as typeof EventSource);
  const stop = store.start();
  try {
    await flush();
    expect(calls).toEqual([]);
    expect(store.getState().snapshot?.seq).toBe(5);
  } finally {
    stop();
    if (previousTauri) host.__TAURI__ = previousTauri;
    else delete host.__TAURI__;
    expect(platform.desktop).toBe(!!host.__TAURI__);
  }
});

test("settings offers browser notification permission once for important and all", async () => {
  const previousNotification = Object.getOwnPropertyDescriptor(globalThis, "Notification");
  const previousTauri = host.__TAURI__;
  const previousVnode = options.vnode;
  delete host.__TAURI__;
  expect(platform.desktop).toBe(false);
  let requests = 0;
  let allow: (() => void) | undefined;
  class FakeNotification {
    static permission: NotificationPermission = "default";
    static requestPermission() { requests += 1; this.permission = "granted"; return Promise.resolve(this.permission); }
  }
  Object.defineProperty(globalThis, "Notification", { configurable: true, writable: true, value: FakeNotification });
  options.vnode = node => {
    previousVnode?.(node);
    const props = node.props as { children?: unknown; onClick?: () => void };
    if (props?.children === "Allow browser notifications" && typeof props.onClick === "function") allow = props.onClick;
  };
  const state = { ...initialState(), snapshot: { executors: [], accounts: [], hosts: [], repos: [] } };
  const render = (level: string) => renderToString(h(TaskContext.Provider, {
    value: { state, api: { call: async () => ({}) } },
  } as never, h(SettingsGeneral, { section: "app", initialData: { ...settings, notifications: { level } } })));
  try {
    const html = render("important");
    expect(html).toContain("Allow browser notifications");
    allow!();
    allow!();
    await Promise.resolve();
    expect(requests).toBe(1);
    expect(render("off")).not.toContain("Allow browser notifications");
    FakeNotification.permission = "granted";
    expect(render("all")).not.toContain("Allow browser notifications");
    FakeNotification.permission = "default";
    host.__TAURI__ = { core: { invoke: async () => true } };
    expect(platform.desktop).toBe(true);
    expect(render("all")).not.toContain("Allow browser notifications");
  } finally {
    options.vnode = previousVnode;
    if (previousNotification) Object.defineProperty(globalThis, "Notification", previousNotification);
    else Reflect.deleteProperty(globalThis, "Notification");
    if (previousTauri) host.__TAURI__ = previousTauri;
    else delete host.__TAURI__;
    expect(platform.desktop).toBe(!!host.__TAURI__);
  }
});
