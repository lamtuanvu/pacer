import { expect, test } from "bun:test";
import { DesktopBanners } from "../app/src/screens/settings/General";
import type { BrowserApi } from "../app/src/data/api";
import { clickText, domText, findByText, installDom, mount, tick, until, unmount } from "./app-setup-health-dom";

const SETTINGS_URL = "x-apple.systempreferences:com.apple.Notifications-Settings.extension";

function fakeApi(handler?: (op: string, params?: unknown) => Promise<unknown>): Pick<BrowserApi, "call"> {
  return {
    call: async <T = unknown>(op: string, params?: unknown): Promise<T> =>
      handler ? (await handler(op, params)) as T : {} as T,
  };
}

function base() {
  const dom = installDom();
  return {
    dom,
    ok: (level = "ok", detail = "Banners allowed · test delivered", tested_at?: number) => ({ level, detail, tested_at }),
    remedy: (over: Record<string, unknown> = {}) => ({ kind: "auto", label: "Allow notifications", op: "notifications.request", ...over }),
  };
}

function anyTextAttr(root: unknown, name: string, value: string): boolean {
  const walk = (node: unknown): boolean => {
    if (!node || typeof node !== "object") return false;
    const n = node as { attrs?: Record<string, string>; childNodes?: unknown[] };
    if (n.attrs?.[name] === value) return true;
    return (n.childNodes ?? []).some(walk);
  };
  return walk(root);
}

test("Desktop banners caption is a polite live region", async () => {
  const { dom } = base();
  try {
    await mount(dom, <DesktopBanners
      api={fakeApi()}
      reload={() => {}}
      level="ok"
      caption="Allowed · test delivered 2m ago"
    />);
    await tick();
    expect(anyTextAttr(dom.container, "aria-live", "polite")).toBe(true);
    expect(domText(dom.container)).toContain("Allowed · test delivered 2m ago");
  } finally { await unmountSafe(dom); }
});

test("Send test is shown only when the check level is ok", async () => {
  const { dom } = base();
  try {
    await mount(dom, <DesktopBanners api={fakeApi()} reload={() => {}} level="info" caption="Notifications are off" />);
    await tick();
    expect(domText(dom.container)).not.toContain("Send test");
    await mount(dom, <DesktopBanners api={fakeApi()} reload={() => {}} level="ok" caption="Allowed · not tested yet" />);
    await tick();
    expect(domText(dom.container)).toContain("Send test");
  } finally { await unmountSafe(dom); }
});

test("remedy button renders for warn/needs-attention states", async () => {
  const { dom } = base();
  try {
    await mount(dom, <DesktopBanners api={fakeApi()} reload={() => {}} level="warn" caption="Not asked yet" remedy={base().remedy()} />);
    await tick();
    expect(domText(dom.container)).toContain("Allow notifications");
  } finally { await unmountSafe(dom); }
});

test("clicking the request remedy shows 'Answer the macOS prompt…' and refetches", async () => {
  const { dom } = base();
  const calls: string[] = [];
  let resolveCall: () => void = () => {};
  const op = new Promise<void>(resolve => { resolveCall = resolve; });
  const api = fakeApi((name) => { calls.push(name); return op.then(() => ({})); });
  let reloads = 0;
  try {
    await mount(dom, <DesktopBanners api={api} reload={() => { reloads++; }} level="warn" caption="Not asked yet" remedy={base().remedy()} />);
    await tick();
    clickText(dom.container, "Allow notifications");
    await tick();
    // While in flight the button is aria-disabled and the progress text is shown.
    expect(domText(dom.container)).toContain("Answer the macOS prompt…");
    resolveCall();
    await tick();
    await tick();
    expect(calls).toEqual(["notifications.request"]);
    expect(reloads).toBe(1);
  } finally { resolveCall(); await unmount(dom); }
});

test("a failed remedy shows an inline error and still refetches nothing", async () => {
  const { dom } = base();
  const api = fakeApi(() => Promise.reject(new Error("Service request failed")));
  let reloads = 0;
  try {
    await mount(dom, <DesktopBanners api={api} reload={() => { reloads++; }} level="warn" caption="Not asked yet" remedy={base().remedy()} />);
    await tick();
    clickText(dom.container, "Allow notifications");
    await tick();
    await tick();
    expect(domText(dom.container)).toContain("Service request failed");
    expect(reloads).toBe(0);
  } finally { await unmountSafe(dom); }
});

test("Send test refetches after the ack", async () => {
  const { dom } = base();
  const calls: string[] = [];
  let reloads = 0;
  const api = fakeApi((name) => { calls.push(name); return Promise.resolve({}); });
  try {
    await mount(dom, <DesktopBanners api={api} reload={() => { reloads++; }} level="ok" caption="Allowed · not tested yet" />);
    await tick();
    clickText(dom.container, "Send test");
    await tick();
    expect(calls).toEqual(["notifications.test"]);
    // The caption-refresh also runs once immediately; the delayed refetch is `window.setTimeout`.
    expect(reloads).toBe(1);
  } finally { await unmountSafe(dom); }
});

test("the request remedy button is aria-disabled while its call is in flight", async () => {
  const { dom } = base();
  let resolveCall!: () => void;
  const api = fakeApi(() => new Promise(resolve => { resolveCall = () => resolve({}); }));
  try {
    await mount(dom, <DesktopBanners api={api} reload={() => {}} level="warn" caption="Not asked yet" remedy={base().remedy()} />);
    await tick();
    clickText(dom.container, "Allow notifications");
    await tick();
    const btn = findByText(dom.container, "Allow notifications")!;
    expect(btn.attrs["aria-disabled"]).toBe("true");
    expect(domText(dom.container)).toContain("Answer the macOS prompt…");
    resolveCall();
    await tick();
    await tick();
    // Once the call completes the button is re-enabled (aria-disabled removed).
    expect(btn.attrs["aria-disabled"]).toBeUndefined();
  } finally { resolveCall?.(); await unmountSafe(dom); }
});

test("a System Settings remedy opens through the allowlisted openSystemSettings command", async () => {
  const { dom } = base();
  const commands: [string, unknown][] = [];
  const previousTauri = (globalThis as { __TAURI__?: unknown }).__TAURI__;
  (globalThis as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke: async (cmd: string, args: unknown) => { commands.push([cmd, args]); return null; } } };
  try {
    const settingsRemedy = { kind: "user", label: "Open Notification settings", url: SETTINGS_URL };
    await mount(dom, <DesktopBanners api={fakeApi()} reload={() => {}} level="warn" caption="Blocked in System Settings" remedy={settingsRemedy} />);
    await tick();
    clickText(dom.container, "Open Notification settings");
    await until(() => commands.length > 0);
    expect(commands).toContainEqual(["open_system_settings", { pane: "notifications" }]);
  } finally {
    (globalThis as { __TAURI__?: unknown }).__TAURI__ = previousTauri;
    await unmountSafe(dom);
  }
});

test("Send test schedules a delayed refetch that is cleared on unmount", async () => {
  const { dom } = base();
  const calls: string[] = [];
  let reloads = 0;
  const api = fakeApi((name) => { calls.push(name); return Promise.resolve({}); });
  try {
    await mount(dom, <DesktopBanners api={api} reload={() => { reloads++; }} level="ok" caption="Allowed · not tested yet" refetchDelay={30} />);
    await tick();
    clickText(dom.container, "Send test");
    await until(() => reloads === 1); // the caption refetch runs once right after the ack
    // Leave before the delayed refetch fires; the timer must be cleared on unmount.
    await unmount(dom);
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(reloads).toBe(1);
  } finally { await unmountSafe(dom); }
});

async function unmountSafe(dom: ReturnType<typeof installDom>): Promise<void> {
  try {
    await unmount(dom);
    dom.restore();
  } catch { /* already torn down */ }
}