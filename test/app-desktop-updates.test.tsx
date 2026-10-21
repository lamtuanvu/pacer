import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { TaskContext } from "../app/src/screens/task-shared";
import { initialState } from "../app/src/data/store";
import { emptySnapshot } from "../src/link/envelope";
import { DesktopUpdate, UpdatesSection } from "../app/src/screens/settings/Updates";
import { desktopStatus } from "./fixtures/desktop-update/status";
import { createActionRunner } from "../app/src/data/actions";
import { ApiError } from "../app/src/data/api";
import type { UpdateStatus } from "../src/update/desktop/types";
const api = { call: async <T,>() => ({} as T), hello: async () => ({ protocol: "3.0.0", pacer: "0.2.3", ops: [], events: [] }), snapshot: async () => ({ protocol: "3.0.0", seq: 0, snapshot: emptySnapshot() }) };
const render = (status: UpdateStatus, ops = status.actions.map(action => `desktop.update.${action}`), connected = true) => renderToString(<TaskContext.Provider value={{ api, state: { ...initialState(), connected, features: { readModel: true, ops: new Set(ops) }, snapshot: { ...emptySnapshot(), desktopUpdates: [status] } } }}><DesktopUpdate status={status}/></TaskContext.Provider>);
test("desktop ready renders one primary action, checked time and safely escaped release notes", () => {
  const html = render(desktopStatus({ phase: "ready", target: "0.2.4", actions: ["restart", "check", "configure"], releaseNotes: '<img src=x onerror="alert(1)">' }));
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
test("update conflicts refresh status and retain explicit failure rather than claiming another client succeeded", async () => {
  let refreshed = 0;
  const runner = createActionRunner({ call: async () => { throw new ApiError("conflict", "Status changed"); }, waitFor: async () => false, refetch: async () => { refreshed++; }, navigate() {} });
  const result = await runner.run("update", { label: "Restart to update", op: "desktop.update.restart", params: {} });
  expect(result).toMatchObject({ status: "error", message: "Status changed" }); expect(refreshed).toBe(1);
});
test("successful desktop requests refresh authoritative state", async () => {
  let refreshed = 0;
  const runner = createActionRunner({ call: async <T,>() => ({} as T), waitFor: async () => false, refetch: async () => { refreshed++; }, navigate() {} });
  expect((await runner.run("update", { label: "Cancel update", op: "desktop.update.cancel", params: {} })).status).toBe("done"); expect(refreshed).toBe(1);
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
test('settings sidebar links the same update state and labels its status',async()=>{
 const {SettingsPanel}=await import('../app/src/shell/SettingsPanel');
 const html=renderToString(<SettingsPanel route={{name:'settings',section:'updates',query:{repo:null,scope:null}}} counts={null} snapshot={{...emptySnapshot(),desktopUpdates:[desktopStatus({phase:'ready',actions:['restart']})]}}/>);
 expect(html).toContain('aria-label="Update ready"');expect(html).toContain('#/settings/updates');
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
