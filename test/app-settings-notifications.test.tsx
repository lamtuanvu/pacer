import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { NotificationsSection, SettingsGeneral, notificationCaption } from "../app/src/screens/settings/General";
import { TaskContext } from "../app/src/screens/task-shared";
import { ActionContext } from "../app/src/data/action-context";
import { initialState } from "../app/src/data/store";
import { settings } from "./fixtures/ui/settings";

/**
 * The Settings › Notifications "Desktop banners" row shows live state in its
 * caption, derived from doctor.run's Notifications check, and its control is
 * the check's remedy (or Send test when the check is ok). The row is
 * desktop-only and rendered through the shared SettingRow; these tests pin the
 * caption mapping for every state the doctor can report, preferring the
 * check's remedy op/url over the exact detail text.
 */
type CaptionCheck = { level: string; detail: string; remedy?: { op?: string; url?: string; caption?: string } };

const SETTINGS_URL = "x-apple.systempreferences:com.apple.Notifications-Settings.extension";

test("Desktop banners caption reads 'Not asked yet' for an undetermined permission", () => {
  const check: CaptionCheck = { level: "warn", detail: "Notification permission not asked yet", remedy: { op: "notifications.request" } };
  expect(notificationCaption(check)).toBe("Not asked yet");
});

test("Desktop banners caption reads 'Blocked in System Settings' for a denial", () => {
  const check: CaptionCheck = { level: "warn", detail: "Notifications are blocked in System Settings", remedy: { url: SETTINGS_URL, caption: "Turn on Allow notifications for pacer" } };
  expect(notificationCaption(check)).toBe("Blocked in System Settings");
});

test("Desktop banners caption names quiet delivery when banners are off", () => {
  const check: CaptionCheck = { level: "warn", detail: "Notifications arrive quietly, without banners", remedy: { url: SETTINGS_URL, caption: "Choose Banners for pacer" } };
  expect(notificationCaption(check)).toBe("Notifications arrive quietly, without banners");
});

test("Desktop banners caption names an unconfirmed test", () => {
  const check: CaptionCheck = { level: "warn", detail: "The desktop didn't confirm the test notification", remedy: { op: "notifications.test" } };
  expect(notificationCaption(check)).toBe("The desktop didn't confirm the test notification");
});

test("Desktop banners caption keeps a rejected banner detail as-is", () => {
  const check: CaptionCheck = { level: "warn", detail: "The banner was rejected: denied", remedy: { op: "notifications.test" } };
  expect(notificationCaption(check)).toBe("The banner was rejected: denied");
});

test("Desktop banners caption keeps an unhandled warn detail as-is", () => {
  expect(notificationCaption({ level: "warn", detail: "Some custom problem" })).toBe("Some custom problem");
});

test("Desktop banners caption reports an untested but allowed permission", () => {
  expect(notificationCaption({ level: "ok", detail: "Banners allowed · not tested yet" })).toBe("Allowed · not tested yet");
});

test("Desktop banners caption reports a delivered test relatively", () => {
  const tested_at = Date.now() / 1000 - 2 * 60;
  const caption = notificationCaption({ level: "ok", detail: "Banners allowed · test delivered", tested_at });
  expect(caption).toMatch(/^Allowed · test delivered \d+m ago$/);
});

test("Desktop banners caption passes informational states through", () => {
  expect(notificationCaption({ level: "info", detail: "The pacer app isn't open; banners come from the system fallback" }))
    .toBe("The pacer app isn't open; banners come from the system fallback");
  expect(notificationCaption({ level: "info", detail: "This development build can't post banners" })).toBe("This development build can't post banners");
  expect(notificationCaption({ level: "info", detail: "Notifications are off" })).toBe("Notifications are off");
});

test("Desktop banners caption shows a checking placeholder before the doctor answers", () => {
  expect(notificationCaption(undefined)).toBe("Checking…");
});

/** Drive the App preferences board as if it lived in the desktop (tauri) shell. */
const desktopState = { ...initialState(), snapshot: { executors: [], accounts: [], hosts: [], repos: [] } } as any;

/** Run `body` with navigator.platform pinned, so the macOS gate does not depend on the test host. */
function withPlatform<T>(platform: string, body: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { ...globalThis.navigator, platform }, configurable: true, writable: true });
  const restore = () => { previous ? Object.defineProperty(globalThis, "navigator", previous) : delete (globalThis as { navigator?: unknown }).navigator; };
  try {
    const result = body();
    if (result instanceof Promise) return result.finally(restore) as T;
    restore();
    return result;
  } catch (error) { restore(); throw error; }
}

const SOUND_LABELS = ["Pacer drop", "System default", "Off", "Basso", "Blow", "Bottle", "Frog", "Funk", "Glass", "Hero", "Morse", "Ping", "Pop", "Purr", "Sosumi", "Submarine", "Tink"];

test("Notification sound picker renders in the macOS desktop shell and offers every sound", () => withPlatform("MacIntel", async () => {
  const { options } = await import("preact");
  let picker: { "aria-label"?: string; value?: string; options?: { value: string; label: string }[] } | undefined;
  const old = options.vnode;
  options.vnode = node => {
    old?.(node);
    const props = node.props as any;
    if (props?.["aria-label"] === "Notification sound" && typeof props.onValueChange === "function") picker = props;
  };
  const host = globalThis as { __TAURI__?: unknown };
  const previous = host.__TAURI__;
  try {
    host.__TAURI__ = { core: { invoke: async () => true } };
    const html = renderToString(<TaskContext.Provider value={{ state: desktopState, api: {} as any }}><SettingsGeneral section="app" initialData={{ ...settings, notifications: { level: 'important', sound: 'glass' } }} /></TaskContext.Provider>);
    expect(html).toContain("Notification sound");
    expect(html).toContain("Sound played when a banner appears.");
    // The trigger is a listbox button named for the setting and shows the stored choice.
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain('aria-label="Notification sound"');
    expect(html).toContain("Glass");
  } finally {
    previous ? host.__TAURI__ = previous : delete host.__TAURI__;
    options.vnode = old;
  }
  expect(picker?.value).toBe("glass");
  expect(picker?.options?.map(option => option.label)).toEqual(SOUND_LABELS);
  expect(picker?.options?.map(option => option.value)).toEqual(["pacer", "default", "off", "basso", "blow", "bottle", "frog", "funk", "glass", "hero", "morse", "ping", "pop", "purr", "sosumi", "submarine", "tink"]);
}));

test("Notification sound row is hidden in a non-macOS desktop shell", () => withPlatform("Linux x86_64", () => {
  const host = globalThis as { __TAURI__?: unknown };
  const previous = host.__TAURI__;
  try {
    host.__TAURI__ = { core: { invoke: async () => true } };
    const html = renderToString(<TaskContext.Provider value={{ state: desktopState, api: {} as any }}><SettingsGeneral section="app" initialData={{ ...settings, notifications: { level: 'important', sound: 'pacer' } }} /></TaskContext.Provider>);
    expect(html).not.toContain("Notification sound");
    expect(html).not.toContain("Pacer drop");
  } finally {
    previous ? host.__TAURI__ = previous : delete host.__TAURI__;
  }
}));

test("Notification sound row is hidden in the browser shell", () => {
  const host = globalThis as { __TAURI__?: unknown };
  const previous = host.__TAURI__;
  try {
    delete host.__TAURI__;
    const html = renderToString(<TaskContext.Provider value={{ state: desktopState, api: {} as any }}><SettingsGeneral section="app" initialData={{ ...settings, notifications: { level: 'important', sound: 'pacer' } }} /></TaskContext.Provider>);
    expect(html).not.toContain("Notification sound");
    expect(html).not.toContain("Pacer");
  } finally {
    previous ? host.__TAURI__ = previous : delete host.__TAURI__;
  }
});

test("the Notification sound control writes only the sound key", () => withPlatform("MacIntel", async () => {
  const { options } = await import("preact");
  const handlers = new Map<string, (value: string) => void>();
  const old = options.vnode;
  options.vnode = node => {
    old?.(node);
    const props = node.props as any;
    if (typeof props?.["aria-label"] === "string" && typeof props.onValueChange === "function" && Array.isArray(props.options)) handlers.set(props["aria-label"], props.onValueChange);
  };
  const calls: unknown[] = [];
  const runner = { run: async (_key: string, request: any) => { calls.push({ op: request.op, params: request.params }); return { status: "done" }; }, result: () => ({}) } as any;
  const host = globalThis as { __TAURI__?: unknown };
  const previous = host.__TAURI__;
  const mount = () => renderToString(<ActionContext.Provider value={runner}><TaskContext.Provider value={{ state: desktopState, api: {call: async (op: string, params: unknown) => { calls.push({ op, params }); return {}; }} as any }}><SettingsGeneral section="app" initialData={{ ...settings, notifications: { level: 'important', sound: 'pacer' } }} /></TaskContext.Provider></ActionContext.Provider>);
  try {
    host.__TAURI__ = { core: { invoke: async () => true } };
    const settle = () => new Promise(resolve => setTimeout(resolve, 0));
    mount();
    for (const sound of ["default", "glass", "off", "pacer"]) { handlers.get("Notification sound")!(sound); await settle(); }
  } finally {
    previous ? host.__TAURI__ = previous : delete host.__TAURI__;
    options.vnode = old;
  }
  expect(calls).toEqual([
    { op: "notifications.set", params: { sound: "default" } },
    { op: "notifications.set", params: { sound: "glass" } },
    { op: "notifications.set", params: { sound: "off" } },
    { op: "notifications.set", params: { sound: "pacer" } },
  ]);
}));

/** Mount the Notifications section in the macOS desktop shell with a fake service, and return the calls it made. */
async function mountMacSettings(health: unknown, body: (dom: import("./app-setup-health-dom").TestDom, calls: { op: string; params: unknown }[]) => Promise<void>, navigatorPlatform = "MacIntel") {
  const { installDom, mount, unmount } = await import("./app-setup-health-dom");
  const calls: { op: string; params: unknown }[] = [];
  const api = { call: async (op: string, params: unknown) => { calls.push({ op, params }); return op === "notifications.health" ? health : op === "notifications.get" ? { level: "important", sound: "glass" } : {}; } } as any;
  const host = globalThis as { __TAURI__?: unknown };
  const previous = host.__TAURI__;
  const dom = installDom();
  const observer = globalThis as { ResizeObserver?: unknown; cancelAnimationFrame?: unknown };
  const previousObserver = observer.ResizeObserver, previousCancel = observer.cancelAnimationFrame;
  await withPlatform(navigatorPlatform, async () => {
    try {
      observer.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
      observer.cancelAnimationFrame ??= (id: number) => clearTimeout(id);
      host.__TAURI__ = { core: { invoke: async () => true } };
      await mount(dom, <TaskContext.Provider value={{ state: desktopState, api }}><NotificationsSection initialData={{ level: "important", sound: "glass" }} /></TaskContext.Provider>);
      await body(dom, calls);
    } finally {
      await unmount(dom).catch(() => {});
      previous ? host.__TAURI__ = previous : delete host.__TAURI__;
      if (previousObserver === undefined) delete observer.ResizeObserver;
      if (previousCancel === undefined) delete observer.cancelAnimationFrame;
      dom.restore();
    }
  });
}

/** The setting-row label of the control whose text is `text`. */
async function rowOf(root: Parameters<typeof import("./app-setup-health-dom").findByText>[0], text: string): Promise<string | undefined> {
  const { findByText, nodeText } = await import("./app-setup-health-dom");
  type Node = typeof root;
  const hasClass = (node: Node, name: string) => (node.className ?? "").split(/\s+/).includes(name);
  const find = (node: Node, name: string): Node | undefined => hasClass(node, name) ? node : node.childNodes.map(child => find(child, name)).find(Boolean);
  let node: Node | null = findByText(root, text);
  while (node && !hasClass(node, "pc-setting-row")) node = node.parentNode;
  const label = node ? find(node, "pc-setting-row__label") : undefined;
  return label ? nodeText(label).trim() : undefined;
}

test("Send test beside the macOS sound picker calls notifications.test and is offered once", async () => {
  const { clickText, domText, until, tick } = await import("./app-setup-health-dom");
  await mountMacSettings({ level: "ok", detail: "Banners allowed · not tested yet" }, async (dom, calls) => {
    await until(() => domText(dom.container).includes("Send test"));
    expect(domText(dom.container).split("Send test").length - 1).toBe(1);
    expect(await rowOf(dom.container, "Send test")).toBe("Notification sound");
    expect(domText(dom.container)).toContain("Allowed · not tested yet");
    clickText(dom.container, "Send test");
    await tick();
    await tick();
    expect(calls.filter(call => call.op === "notifications.test")).toEqual([{ op: "notifications.test", params: {} }]);
    expect(calls.some(call => call.op === "notifications.set")).toBe(false);
  });
});

test("without permission the remedy stays in the Desktop banners row, not beside the sound picker", async () => {
  const { domText, until } = await import("./app-setup-health-dom");
  await mountMacSettings({ level: "warn", detail: "Notifications not requested", remedy: { label: "Allow notifications", op: "notifications.request" } }, async dom => {
    await until(() => domText(dom.container).includes("Allow notifications"));
    const text = domText(dom.container);
    expect(text).not.toContain("Send test");
    expect(text.split("Allow notifications").length - 1).toBe(1);
    expect(await rowOf(dom.container, "Allow notifications")).toBe("Desktop banners");
    expect(text).toContain("Not asked yet");
  });
});

test("on a non-macOS desktop Send test stays in the Desktop banners row and no sound picker shows", async () => {
  const { domText, until } = await import("./app-setup-health-dom");
  await mountMacSettings({ level: "ok", detail: "Banners allowed · not tested yet" }, async dom => {
    await until(() => domText(dom.container).includes("Send test"));
    expect(domText(dom.container)).not.toContain("Notification sound");
    expect(await rowOf(dom.container, "Send test")).toBe("Desktop banners");
  }, "Linux x86_64");
});

test("the sound picker sizes its menu to the longest label and Saved follows Send test", async () => {
  const { domText, findByText, until } = await import("./app-setup-health-dom");
  await mountMacSettings({ level: "ok", detail: "Banners allowed · not tested yet" }, async dom => {
    await until(() => domText(dom.container).includes("Send test"));
    type Node = typeof dom.container;
    const hasClass = (node: Node, name: string) => (node.className ?? "").split(/\s+/).includes(name);
    const ancestor = (node: Node | null, name: string) => { while (node && !hasClass(node, name)) node = node.parentNode; return node; };
    // Content sizing lets the menu grow past the trigger, so "System default" is not cut off.
    expect(ancestor(findByText(dom.container, "Glass"), "pc-choice-picker--content")).toBeTruthy();
    // Send test is inside the save boundary's control, so the "Saved" status renders after it
    // rather than between the picker and the button.
    const send = findByText(dom.container, "Send test");
    expect(ancestor(send, "pc-immediate-save__control")).toBeTruthy();
    // In document order the status comes after Send test, never between it and the picker.
    const order: Node[] = [];
    const walk = (node: Node) => { order.push(node); node.childNodes.forEach(walk); };
    walk(dom.container);
    const status = order.find(node => hasClass(node, "pc-immediate-save__status") && ancestor(node, "pc-setting-row") === ancestor(send, "pc-setting-row"));
    expect(status).toBeTruthy();
    expect(order.indexOf(status!)).toBeGreaterThan(order.indexOf(send!));
  });
});
