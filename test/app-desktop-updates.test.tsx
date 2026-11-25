import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { TaskContext } from "../app/src/screens/task-shared";
import { initialState, reduceStore } from "../app/src/data/store";
import { emptySnapshot } from "../src/link/envelope";
import { DesktopUpdate, UpdatesSection } from "../app/src/screens/settings/Updates";
import { desktopStatus } from "./fixtures/desktop-update/status";
import { createActionRunner } from "../app/src/data/actions";
import { ApiError } from "../app/src/data/api";
import type { UpdateStatus } from "../src/update/desktop/types";
const api = { call: async <T,>() => ({} as T), hello: async () => ({ protocol: "3.0.0", pacer: "0.2.3", ops: [], events: [] }), snapshot: async () => ({ protocol: "3.0.0", seq: 0, snapshot: emptySnapshot() }) };
const render = (status: UpdateStatus, ops = status.actions.map(action => `desktop.update.${action}`), connected = true) => renderToString(<TaskContext.Provider value={{ api, state: { ...initialState(), connected, features: { readModel: true, ops: new Set(ops) }, snapshot: { ...emptySnapshot(), desktopUpdates: [status] } } }}><DesktopUpdate status={status}/></TaskContext.Provider>);
test("an unchecked desktop says Not checked yet instead of Last checked Not checked", () => {
  const html = render(desktopStatus({ checkedAt: null, actions: ["check"] }));
  expect(html).toContain("Not checked yet");
  expect(html).not.toContain("Last checked Not checked");
  expect(render(desktopStatus({ checkedAt: 10, actions: ["check"] }))).toContain("Last checked");
});
test("an interrupted check is neutral on screen and never shows adapter internals", () => {
  const html = render(desktopStatus({ phase: "error", actions: ["check", "retry"], error: {
    code: "check_unavailable", message: "Desktop update adapter operation was cancelled",
  } }));
  expect(html).toContain("Couldn't check for updates");
  expect(html).toContain("Check for updates");
  expect(html).not.toContain("Update needs attention");
  expect(html).not.toContain("Desktop update adapter");
});

test("desktop ready renders one primary action, checked time and safely escaped release notes", () => {
  const html = render(desktopStatus({ phase: "ready", target: "0.2.4", checkedAt: 10, actions: ["restart", "check", "configure"], releaseNotes: '<img src=x onerror="alert(1)">' }));
  expect(html).toContain("Restart to update"); expect(html).toContain("0.2.3 → 0.2.4");
  expect(html).toContain("&lt;img"); expect(html).not.toContain("<img");
  expect(html.match(/pc-btn--primary/g)).toHaveLength(1); expect(html).toContain('aria-live="polite"'); expect(html).toContain("Last checked");
});
test("automatic download is capability gated and never grants restart permission", () => {
  const status = desktopStatus({ autoDownload: false, target: "0.2.4", actions: ["check", "download", "configure"] });
  const html = render(status); expect(html).toContain("Download update"); expect(html).not.toContain("Restart to update");
  expect(html).toContain("Download updates automatically"); expect(html).not.toMatch(/type="checkbox"[^>]* checked/);
  expect(render(status, ["desktop.update.check"])).not.toContain("Download update</button>");
  expect(render(status, [], false)).toContain("Reconnecting");
});
test("waiting describes task and session blockers, cancel disappears after reservation", () => {
  const html = render(desktopStatus({ phase: "waiting", actions: ["cancel"], blockers: [{ kind: "task", id: "t1", label: "Running task" }, { kind: "session", id: "s1", label: "Interactive session" }] }));
  expect(html).toContain("Cancel update"); expect(html).toContain("Running task"); expect(html).toContain("Interactive session");
  const installed = render(desktopStatus({ phase: "installing", actions: [] })); expect(installed).not.toContain("Cancel update</button>"); expect(installed).toContain("Cancellation is no longer available");
});
test("recovery and attached states preserve truthful copy without unauthorized adoption", () => {
  expect(render(desktopStatus({ phase: "restored" }))).toContain("Your previous version has been restored.");
  expect(render(desktopStatus({ phase: "recovery-failed", actions: [] }))).not.toContain("has been restored");
  const attached = render(desktopStatus({ ownership: "attached", actions: [] })); expect(attached).toContain("externally managed service"); expect(attached).not.toContain("Use the desktop service</button>");
});
test("desktop status replaces the legacy update offer", () => {
  const status = desktopStatus({ phase: "ready", target: "0.2.4", actions: ["restart"] });
  const html = renderToString(<TaskContext.Provider value={{ api, state: { ...initialState(), connected: true, features: { readModel: true, ops: new Set(["desktop.update.restart"]) }, snapshot: { ...emptySnapshot(), desktopUpdates: [status] } } }}><UpdatesSection initialData={{ current: "0.2.3", latest: "0.2.4", available: true }}/></TaskContext.Provider>);
  expect(html).toContain("Restart to update"); expect(html).not.toContain("Update and restart"); expect(html).not.toContain("Orca");
});
test("update conflicts retain explicit failure and wait for entity events", async () => {
  let refreshed = 0;
  const runner = createActionRunner({ call: async () => { throw new ApiError("conflict", "Status changed"); }, waitFor: async () => false, refetch: async () => { refreshed++; }, navigate() {} });
  const result = await runner.run("update", { label: "Restart to update", op: "desktop.update.restart", params: {} });
  expect(result).toMatchObject({ status: "error", message: "Status changed" }); expect(refreshed).toBe(0);
  const old = desktopStatus({phase:'ready',revision:1,target:'0.2.4',actions:['restart']});
  const next = desktopStatus({phase:'downloading',revision:2,target:'0.2.4',actions:['cancel']});
  const state = {...initialState(),needsSnapshot:false,features:{readModel:true,ops:new Set<string>()},snapshot:{...emptySnapshot(),seq:1,desktopUpdates:[old]}};
  const updated = reduceStore(state,{type:'event',event:{type:'desktop.update',seq:2,at:2,data:next}});
  expect(updated.snapshot!.desktopUpdates![0]).toEqual(next);
  const html = render(updated.snapshot!.desktopUpdates![0]!);
  expect(html).toContain('Cancel update'); expect(html).not.toContain('Restart to update');

});
test("successful desktop requests wait for authoritative entity events", async () => {
  let refreshed = 0;
  const runner = createActionRunner({ call: async <T,>() => ({} as T), waitFor: async () => false, refetch: async () => { refreshed++; }, navigate() {} });
  expect((await runner.run("update", { label: "Cancel update", op: "desktop.update.cancel", params: {} })).status).toBe("done"); expect(refreshed).toBe(0);
});

test("tray update indicator links shared settings without a second install mechanism", async () => {
  const { Tray } = await import("../app/src/tray/Tray");
  const { createTrayIpc } = await import("../app/src/tray/ipc");
  const html = renderToString(<Tray api={api} ipc={createTrayIpc({ location: { assign() {} } })} snapshot={{ ...emptySnapshot(), desktopUpdates: [desktopStatus({ phase: "ready", target: "0.2.4", actions: ["restart"] })] }}/>);
  expect(html).toContain('href="/app/#/settings/updates"'); expect(html).toContain("Update ready"); expect(html).not.toContain("Restart to update</button>");
});
test("legacy update check does not retrigger on its own update event", async () => {
  const { resourceRevision } = await import('../app/src/screens/settings/shared');
  expect(resourceRevision('update.check', { update: 1, config: 1 })).toBe(resourceRevision('update.check', { update: 2, config: 1 }));
  expect(resourceRevision('update.check', { config: 2 })).not.toBe(resourceRevision('update.check', { config: 1 }));
  expect(resourceRevision('config.get', { update: 1 })).not.toBe(resourceRevision('config.get', { update: 2 }));
});
test('settings sidebar selects App preferences while update status stays on the page',async()=>{
 const {SettingsPanel}=await import('../app/src/shell/SettingsPanel');
 const html=renderToString(<SettingsPanel route={{name:'settings',section:'updates',query:{repo:null,scope:null}}} counts={null} snapshot={{...emptySnapshot(),desktopUpdates:[desktopStatus({phase:'ready',actions:['restart']})]}}/>);
 expect(html).toContain('Checks not run');expect(html).toMatch(/<a(?=[^>]*href="#\/settings\/app")(?=[^>]*aria-current="page")/);
});
test('download preference without configure permission is a fact, not an unexplained disabled control',()=>{
 const html=render(desktopStatus({phase:'ready',target:'0.2.4',actions:['restart']}));
 expect(html).not.toContain('type="checkbox"');expect(html).toContain('Automatic downloads are on.');
 // While installing, recovering, or attached, the preference is beside the point and is not shown.
 for(const status of [desktopStatus({phase:'installing',actions:[]}),desktopStatus({phase:'recovery-failed',actions:[]}),desktopStatus({ownership:'attached',actions:[]})])expect(render(status)).not.toContain('Automatic downloads are');
});
test('a completed update displays the installed version once',()=>{
 const html=render(desktopStatus({phase:'complete',current:'0.2.4',target:'0.2.4',actions:['check']}));
 expect(html).not.toContain('0.2.4 → 0.2.4');expect(html).toContain('pacer desktop · 0.2.4');
});
test('adoption details expose inspected service change and separate work blockers',async()=>{
 const {adoptionStatus}=await import('./fixtures/desktop-update/status');
 const adoption=adoptionStatus({phase:'waiting',revision:2,blockers:[{kind:'session',id:'s',label:'Live terminal'}]});
 const html=render(desktopStatus({adoption,actions:['adoptCancel']}));
 expect(html).toContain('Cancel service change');expect(html).toContain('Live terminal');
 // Paths are complete, with a break opportunity after each '/'.
 const text=html.replaceAll('<wbr/>','');expect(text).toContain(adoption.currentServiceExecutable);expect(text).toContain(adoption.replacementServiceExecutable);expect(html).toContain('/<wbr/>');
 const committed=render(desktopStatus({adoption:adoptionStatus({phase:'committed',resultingInstallationId:'managed-installation'}),actions:[]}));
 expect(committed).toContain('managed-installation');expect(committed).toContain('Desktop service is ready');
});
test("progress is shown but only the phase is announced, and each update is a named group", () => {
  const html = render(desktopStatus({ phase: "downloading", target: "0.2.4", downloadedBytes: 40, totalBytes: 100, actions: ["cancel"] }));
  const live = html.match(/<div role="status" aria-live="polite">(.*?)<\/div>/)?.[1] ?? "";
  expect(live).toContain("Downloading update"); expect(live).not.toContain("40%");
  expect(html).toContain("40% downloaded");
  expect(html).toMatch(/role="group" aria-label="pacer desktop 0\.2\.3"/);
  expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Cancel update/);
});

const channelConfig = (value: "stable" | "nightly") => ({ keys: { update_channel: { value } }, planners: [] });
const renderWithConfig = (status: UpdateStatus, config: ReturnType<typeof channelConfig>) => renderToString(<TaskContext.Provider value={{ api, state: { ...initialState(), connected: true, features: { readModel: true, ops: new Set(status.actions.map(action => `desktop.update.${action}`)) }, snapshot: { ...emptySnapshot(), desktopUpdates: [status] } } }}><DesktopUpdate status={status} initialConfig={config}/></TaskContext.Provider>);
test("the nightly warning is shown only while Nightly is selected", () => {
  const warning = "Nightly builds are untested daily snapshots of main.";
  const status = desktopStatus({ current: "0.16.0", actions: ["check"] });
  expect(renderWithConfig(status, channelConfig("stable"))).not.toContain(warning);
  const nightly = renderWithConfig(status, channelConfig("nightly"));
  expect(nightly).toContain(warning); expect(nightly).toMatch(/data-strip-value="nightly" aria-pressed="true"/);
});
test("stable-channel nightly install shows the catch-up note", () => {
  const note = "You'll move to the next stable release when it's newer than this nightly.";
  const nightly = desktopStatus({ current: "0.16.0-nightly.202611171700", actions: ["check"] });
  const stableChannel = renderWithConfig(nightly, channelConfig("stable"));
  expect(stableChannel).toContain("Update channel");
  expect(stableChannel).toContain(note);
  expect(stableChannel).toMatch(/data-strip-value="stable" aria-pressed="true"/);
  expect(renderWithConfig(nightly, channelConfig("nightly"))).not.toContain(note);
  expect(renderWithConfig(desktopStatus({ current: "0.16.0", actions: ["check"] }), channelConfig("stable"))).not.toContain(note);
});

type FakeNode = { nodeType: number; tagName: string; data?: string; childNodes: FakeNode[]; parentNode: FakeNode | null; attrs: Record<string, string>; style: Record<string, string>; dataset: Record<string, string>; _listeners: Record<string, (event?: unknown) => void>; [key: string]: unknown };
const fakeNode = (tag: string): FakeNode => {
  const node: FakeNode = {
    nodeType: 1, tagName: tag, childNodes: [], parentNode: null, attrs: {}, style: {}, dataset: {}, _listeners: {},
    // Preact keys its handler map by the lowercase DOM event name when the `on…` property exists.
    onclick: null, oninput: null, onfocus: null, onblur: null, onkeydown: null, onchange: null,
    addEventListener(type: string, fn: (event?: unknown) => void) { node._listeners[type] = fn; },
    removeEventListener(type: string) { delete node._listeners[type]; },
    setAttribute(name: string, value: unknown) { node.attrs[name] = String(value); if (name.startsWith("data-")) node.dataset[name.slice(5).replace(/-(\w)/g, (_, c: string) => c.toUpperCase())] = String(value); },
    getAttribute(name: string) { return name in node.attrs ? node.attrs[name] : null; },
    removeAttribute(name: string) { delete node.attrs[name]; },
    appendChild(child: FakeNode) { place(node, child, null); return child; },
    insertBefore(child: FakeNode, before: FakeNode | null) { place(node, child, before); return child; },
    removeChild(child: FakeNode) { node.childNodes = node.childNodes.filter(c => c !== child); child.parentNode = null; return child; },
    contains(other: unknown) { return other === node || node.childNodes.some(child => (child.contains as (o: unknown) => boolean)(other)); },
    focus() {}, querySelector() { return null; }, querySelectorAll() { return []; }, matches() { return false; }, closest() { return null; },
    getBoundingClientRect() { return { width: 0, height: 0 }; }, get isConnected() { return true; }, get ownerDocument() { return globalThis.document; },
  };
  return node;
};
const place = (parent: FakeNode, child: FakeNode, before: FakeNode | null) => {
  if (child.parentNode) child.parentNode.childNodes = child.parentNode.childNodes.filter(c => c !== child);
  const at = before ? parent.childNodes.indexOf(before) : -1;
  if (at < 0) parent.childNodes.push(child); else parent.childNodes.splice(at, 0, child);
  child.parentNode = parent;
};
const textOf = (node: FakeNode): string => node.nodeType === 3 ? node.data ?? "" : node.childNodes.map(textOf).join("");
const findNode = (node: FakeNode, match: (n: FakeNode) => boolean): FakeNode | null => {
  for (const child of node.childNodes) { if (match(child)) return child; const found = findNode(child, match); if (found) return found; }
  return null;
};
test("channel control writes update_channel and requests a check", async () => {
  const keys = ["document", "window", "CSSStyleSheet", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, (globalThis as Record<string, unknown>)[key]]));
  const doc = { adoptedStyleSheets: [], body: null, activeElement: null, createElement: fakeNode, createElementNS: (_ns: string, tag: string) => fakeNode(tag),
    createTextNode: (text: string) => Object.assign(fakeNode("#text"), { nodeType: 3, data: text }),
    dispatchEvent() {}, addEventListener() {}, removeEventListener() {}, getElementById: () => null, querySelector: () => null, contains: () => false };
  Object.assign(globalThis, {
    document: doc, CSSStyleSheet: class { replaceSync() {} }, getComputedStyle: () => ({ getPropertyValue: () => "0px" }),
    window: { addEventListener() {}, removeEventListener() {}, innerHeight: 800, innerWidth: 1200, matchMedia: () => ({ matches: false }), setTimeout, clearTimeout },
    requestAnimationFrame: () => 0, cancelAnimationFrame() {}, ResizeObserver: class { observe() {} disconnect() {} },
  });
  try {
    const { h, render: mount } = await import("preact");
    const { act } = await import("preact/test-utils");
    const { ActionContext } = await import("../app/src/data/action-context");
    const calls: { op: string; params: unknown }[] = [];
    let channel = "stable";
    const call = async <T,>(op: string, params: unknown): Promise<T> => {
      calls.push({ op, params });
      if (op === "config.set") channel = (params as { value: string }).value;
      return (op === "config.get" ? channelConfig(channel as "stable") : {}) as T;
    };
    const live = { ...api, call };
    const status = desktopStatus({ actions: ["check", "configure"] });
    const runner = createActionRunner({ call, waitFor: async () => true, refetch() {}, navigate() {} });
    const container = fakeNode("div");
    const screen = h(TaskContext.Provider, { value: { api: live, state: { ...initialState(), connected: true, features: { readModel: true, ops: new Set(["desktop.update.check", "desktop.update.configure"]) }, snapshot: { ...emptySnapshot(), desktopUpdates: [status] } } } },
      h(ActionContext.Provider, { value: runner }, h(DesktopUpdate, { status, initialConfig: channelConfig("stable") })));
    await act(async () => { mount(screen as never, container as never); });
    const nightly = findNode(container, n => n.tagName === "button" && textOf(n) === "Nightly");
    expect(nightly).toBeTruthy();
    await act(async () => { nightly!._listeners.click!.call(nightly, { type: "click", currentTarget: nightly }); });
    for (let i = 0; i < 200 && !calls.some(c => c.op === "desktop.update.check"); i++) await act(async () => { await new Promise(r => setTimeout(r, 5)); });
    const set = calls.findIndex(c => c.op === "config.set"), check = calls.findIndex(c => c.op === "desktop.update.check");
    expect(calls[set]).toEqual({ op: "config.set", params: { key: "update_channel", value: "nightly" } });
    expect(check).toBeGreaterThan(set);
    expect(calls[check]!.params).toMatchObject({ installationId: status.installationId, expectRevision: status.revision });
    await act(async () => { mount(null, container as never); });
  } finally { Object.assign(globalThis, previous); }
}, 15000);
