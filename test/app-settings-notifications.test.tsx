import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { SettingsGeneral, notificationCaption } from "../app/src/screens/settings/General";
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

test("Notification sound row renders in the macOS desktop shell and offers pacer/default/off", () => withPlatform("MacIntel", () => {
  const host = globalThis as { __TAURI__?: unknown };
  const previous = host.__TAURI__;
  try {
    host.__TAURI__ = { core: { invoke: async () => true } };
    const html = renderToString(<TaskContext.Provider value={{ state: desktopState, api: {} as any }}><SettingsGeneral section="app" initialData={{ ...settings, notifications: { level: 'important', sound: 'pacer' } }} /></TaskContext.Provider>);
    expect(html).toContain("Notification sound");
    expect(html).toContain("Sound played when a banner appears.");
    for (const label of ["Pacer", "System", "Off"]) expect(html).toContain(label);
  } finally {
    previous ? host.__TAURI__ = previous : delete host.__TAURI__;
  }
}));

test("Notification sound row is hidden in a non-macOS desktop shell", () => withPlatform("Linux x86_64", () => {
  const host = globalThis as { __TAURI__?: unknown };
  const previous = host.__TAURI__;
  try {
    host.__TAURI__ = { core: { invoke: async () => true } };
    const html = renderToString(<TaskContext.Provider value={{ state: desktopState, api: {} as any }}><SettingsGeneral section="app" initialData={{ ...settings, notifications: { level: 'important', sound: 'pacer' } }} /></TaskContext.Provider>);
    expect(html).not.toContain("Notification sound");
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
    if (typeof props?.label === "string" && typeof props.onChange === "function" && Array.isArray(props.options)) handlers.set(props.label, props.onChange);
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
    for (const sound of ["default", "off", "pacer"]) { handlers.get("Notification sound")!(sound); await settle(); }
  } finally {
    previous ? host.__TAURI__ = previous : delete host.__TAURI__;
    options.vnode = old;
  }
  expect(calls).toEqual([
    { op: "notifications.set", params: { sound: "default" } },
    { op: "notifications.set", params: { sound: "off" } },
    { op: "notifications.set", params: { sound: "pacer" } },
  ]);
}));
