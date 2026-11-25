import { expect, test } from "bun:test";
import { desktopUpdateView, desktopUpdateAction, updateIntent, desktopUpdateIndicator, desktopConnectionView } from "../src/view-model/updates";
import { desktopStatus } from "./fixtures/desktop-update/status";

test("handshake connection failure is distinct from storage and identity copy", () => {
  expect(desktopConnectionView({ state: "unavailable", reason: "handshake" }).detail).toContain("during handshake");
  expect(desktopConnectionView({ state: "unavailable", reason: "connection" }).detail).toContain("verified desktop update connection");
  expect(desktopConnectionView({ state: "unavailable", reason: "service-identity" }).detail).toContain("could not verify");
});

test("connection failures name the error kind and keep the generic copy when it is absent", () => {
  const generic = desktopConnectionView({ state: "unavailable", reason: "connection" }).detail;
  expect(generic).toContain("verified desktop update connection");
  const expected = {
    busy: "still in progress", timeout: "did not answer in time", unavailable: "could not reach the service",
    io: "connection to the service failed", invalid: "message pacer could not read", interrupted: "was interrupted",
    "recovery-failed": "could not restore the previous version",
  } as const;
  for (const [error, text] of Object.entries(expected)) {
    const detail = desktopConnectionView({ state: "unavailable", reason: "connection", error }).detail;
    expect(detail).toContain(text);
    expect(detail).not.toBe(generic);
  }
  expect(desktopConnectionView({ state: "unavailable", reason: "handshake", error: "busy" }).detail).toContain("during handshake");
});

test("coordination retries describe the pause instead of promising a ready update", () => {
  const view = desktopUpdateView(desktopStatus({ phase: "ready", actions: [], error: {
    code: "coordination_failed", message: "Desktop update paused. Rechecking the connection and saved update state.",
  } }));
  expect(view.label).toBe("Rechecking update");
  expect(view.detail).toContain("Rechecking the connection");
  expect(view.tone).toBe("warn");
  expect(view.primary).toBeNull();
});

test("notification retries explain the delay while preserving authorized controls", () => {
  const view = desktopUpdateView(desktopStatus({ phase: "ready", actions: ["restart", "check"], error: {
    code: "notification_failed", message: "Update status notifications are delayed. Retrying automatically.",
  } }));
  expect(view.label).toBe("Update status delayed");
  expect(view.detail).toContain("Retrying automatically");
  expect(view.primary).toBe("Restart to update");
  expect(view.tone).toBe("warn");
});

test("desktop view uses authoritative actions for ready, waiting and unavailable states", () => {
  const ready = desktopStatus({ phase: "ready", target: "0.2.4", actions: ["restart"] });
  expect(desktopUpdateView(ready).primary).toBe("Restart to update");
  expect(desktopUpdateView({ ...ready, actions: [] }).primary).toBeNull();
  const waiting = desktopStatus({ phase: "waiting", actions: ["cancel"], blockers: [{ kind: "task", id: "t1", label: "Running task" }, { kind: "session", id: "s1", label: "Interactive session" }] });
  expect(desktopUpdateView(waiting)).toMatchObject({ primary: "Cancel update", cancellable: true });
  expect(desktopUpdateView(waiting).detail).toBe("Update will install when 2 running tasks finish. You can cancel while it waits.");
  expect(desktopUpdateView(desktopStatus({ phase: "waiting", actions: ["cancel"], blockers: [{ kind: "task", id: "t1", label: "One" }] })).detail)
    .toBe("Update will install when 1 running task finishes. You can cancel while it waits.");
  expect(desktopUpdateView(desktopStatus({ phase: "installing", actions: [] }))).toMatchObject({ primary: null, cancellable: false });
  expect(desktopUpdateView(desktopStatus({ ownership: "attached", actions: [] })).primary).toBeNull();
});
test("restored and failed recovery never share a success claim", () => {
  const restored = desktopUpdateView(desktopStatus({ phase: "restored", actions: ["check"] }));
  expect(restored.detail).toBe("The update couldn't start. Your previous version has been restored.");
  const failed = desktopUpdateView(desktopStatus({ phase: "recovery-failed", actions: [] }));
  expect(failed.detail).not.toContain("has been restored"); expect(failed.tone).toBe("bad");
});
test("check/download/cancelled-ready status does not invent restart consent or raw internal strings", () => {
  expect(desktopUpdateView(desktopStatus({ target: "0.2.4", autoDownload: false, actions: ["check", "download"] })).primary).toBe("Download update");
  expect(desktopUpdateView(desktopStatus({ phase: "checking", actions: ["cancel"] })).cancellable).toBe(true);
  expect(desktopUpdateView(desktopStatus({ phase: "downloading", actions: ["cancel"], downloadedBytes: 5, totalBytes: 10 })).detail).toContain("50%");
  expect(desktopUpdateView(desktopStatus({ phase: "ready", actions: ["restart"], target: "0.2.4" })).detail).not.toContain("cancelled");
  expect(desktopUpdateView(desktopStatus({ phase: "rolling-back", actions: [] })).label).not.toContain("rolling-back");
});
test("update action binds displayed installation revision/version and rejects unadvertised operations", () => {
  const status = desktopStatus({ phase: "ready", target: "0.2.4", revision: 7, actions: ["restart"] });
  expect(desktopUpdateAction(status, "restart", "ui_request")).toEqual({ label: "Restart to update", op: "desktop.update.restart", params: { installationId: "desktop-fixture", requestId: "ui_request", expectRevision: 7, version: "0.2.4" } });
  expect(() => desktopUpdateAction(status, "cancel", "ui_request")).toThrow();
  expect(() => desktopUpdateAction({ ...status, target: null }, "restart", "ui_request")).toThrow();
});
test("ambiguous identical intent retains request ID while changed revision/action gets a new one", () => {
  let id = 0; const intent = updateIntent(() => `ui_${++id}`), status = desktopStatus();
  expect(intent(status, "check").params.requestId).toBe("ui_1");
  expect(intent(status, "check").params.requestId).toBe("ui_1");
  expect(intent({ ...status, revision: 2 }, "check").params.requestId).toBe("ui_2");
});
test("tray indicator opens shared update state only when a relevant public status exists", () => {
  expect(desktopUpdateIndicator([])).toBeNull();
  expect(desktopUpdateIndicator([desktopStatus()])).toBeNull();
  expect(desktopUpdateIndicator([desktopStatus({ phase: "ready", target: "0.2.4", actions: ["restart"] })])).toMatchObject({ label: "Update ready", route: "/settings/updates" });
});
test("unchecked and future additive phases remain truthful and readable", () => {
  expect(desktopUpdateView(desktopStatus()).label).toBe("Not checked yet");
  expect(desktopUpdateView(desktopStatus({ checkedAt: 10 })).label).toBe("Up to date");
  expect(desktopUpdateView(desktopStatus({ phase: "future-phase" as any, actions: [] })).label).toBe("Update status unavailable");
});
test('operation feedback expires with its result revision and never claims cancellation while installation runs',async()=>{
 const {desktopUpdateFeedback}=await import('../src/view-model/updates');
 const ready=desktopStatus({phase:'ready',revision:4});
 expect(desktopUpdateFeedback('cancel',ready,ready)).toContain('Update cancelled');
 expect(desktopUpdateFeedback('cancel',ready,{...ready,revision:5,phase:'installing'})).toBeNull();
 expect(desktopUpdateFeedback('cancel',{...ready,phase:'waiting'},{...ready,phase:'waiting'})).toBeNull();
});
test('failed recovery preserves evidence and directs the user to an actual issue destination',()=>{
 const detail=desktopUpdateView(desktopStatus({phase:'recovery-failed',actions:[]})).detail;
 expect(detail).toContain('leave the files in your pacer folder as they are');expect(detail).toContain('github.com/lamtuanvu/pacer/issues');expect(detail).not.toContain('Reinstall');
});
test('adoption cancellation uses its separate revision and intent identity', async () => {
 const {adoptionStatus}=await import('./fixtures/desktop-update/status');
 const status=desktopStatus({revision:7,actions:['adoptCancel'],adoption:adoptionStatus({phase:'waiting',revision:3})});
 expect(desktopUpdateView(status)).toMatchObject({label:'Waiting to switch services',primary:'Cancel service change',cancellable:true});
 expect(desktopUpdateAction(status,'adoptCancel','request').params.expectRevision).toBe(3);
 let n=0;const intent=updateIntent(()=>`request-${++n}`);
 expect(intent(status,'adoptCancel').params.requestId).toBe('request-1');
 expect(intent({...status,adoption:{...status.adoption!,revision:4}},'adoptCancel').params.requestId).toBe('request-2');
 expect(desktopUpdateIndicator([status])?.label).toBe('Waiting to switch services');
});
test('adoption confirmation names both inspected executables and ownership transfer',async()=>{
 const {adoptionStatus}=await import('./fixtures/desktop-update/status');
 const {desktopAdoptionConfirmation}=await import('../src/view-model/updates');
 const status=desktopStatus({actions:['adopt'],adoption:adoptionStatus()});
 const confirmation=desktopAdoptionConfirmation(status);
 expect(confirmation).toContain(status.adoption!.currentServiceExecutable);
 expect(confirmation).toContain(status.adoption!.replacementServiceExecutable);
 expect(confirmation).toContain('com.pacer.serve');expect(confirmation).toContain('7433');expect(confirmation).toContain('manage');
 expect(()=>desktopAdoptionConfirmation(desktopStatus())).toThrow();
 expect(desktopUpdateView({...status,adoption:adoptionStatus({phase:'recovery-failed'}),actions:[]}).tone).toBe('bad');
});

test('available service adoption explains why desktop updates need a service change', async () => {
 const {adoptionStatus}=await import('./fixtures/desktop-update/status');
 const view=desktopUpdateView(desktopStatus({phase:'idle',ownership:'attached',actions:['adopt'],adoption:adoptionStatus()}));
 expect(view.label).toBe('Externally managed service');
 expect(view.detail).toContain('enable desktop updates');
 expect(view.detail).not.toContain('Check for a newer version');
});

test('an advertised adoption retry remains confirmable after cancellation or restoration', async () => {
 const {adoptionStatus}=await import('./fixtures/desktop-update/status');
 const {desktopAdoptionConfirmation}=await import('../src/view-model/updates');
 for (const phase of ['cancelled','restored'] as const) {
  const status=desktopStatus({phase:'idle',ownership:'attached',actions:['adopt'],adoption:adoptionStatus({phase})});
  expect(desktopAdoptionConfirmation(status)).toContain(status.adoption!.currentServiceExecutable);
  expect(desktopUpdateAction(status,'adopt','retry').params.expectRevision).toBe(status.revision);
 }
});
test('a completed service change does not hide a later downloaded update',async()=>{
 const {adoptionStatus}=await import('./fixtures/desktop-update/status');
 const view=desktopUpdateView(desktopStatus({phase:'ready',target:'0.2.4',actions:['restart'],adoption:adoptionStatus({phase:'committed',resultingInstallationId:'new-id'})}));
 expect(view.label).toBe('Update ready');expect(view.primary).toBe('Restart to update');
});

test('interrupted and transient checks are neutral, plain-language and offer a check again action', () => {
  for (const error of [
    { code: 'check_unavailable', message: "Couldn't check for updates. Pacer will try again automatically." },
    { code: 'check_interrupted', message: "Couldn't check for updates. Pacer will try again automatically." },
    { code: 'update_failed', message: 'Desktop update adapter operation was cancelled' },
    { code: 'update_failed', message: 'Desktop update adapter closed before successful completion' },
    { code: 'update_failed', message: 'Desktop update adapter operation timed out' },
    { code: 'update_failed', message: 'Verified desktop update adapter is unavailable' },
  ]) {
    const view = desktopUpdateView(desktopStatus({ phase: 'error', actions: ['check', 'retry'], error }));
    expect(view.label).toBe("Couldn't check for updates");
    expect(view.tone).toBe('neutral');
    expect(view.primary).toBe('Check for updates');
    expect(view.detail).not.toContain('adapter');
    expect(view.detail).not.toContain(error.message);
    expect(view.detail).toContain('try again');
    expect(view.detail).toContain('Check for updates');
    expect(view.detail).not.toContain('Pacer');
    expect(view.detail).not.toContain('automatically');
    expect(view.glyph).toBe('?');
  }
});

test('refused and retired parent-channel wording is internal and never rendered raw', () => {
  for (const message of [
    'Desktop update helper launch was refused by the parent channel',
    'Native parent helper launch was refused',
    'Native parent helper channel is retired; restart the service to recover',
  ]) {
    const view = desktopUpdateView(desktopStatus({ phase: 'error', actions: ['check'], error: { code: 'update_failed', message } }));
    expect(view.detail).not.toContain(message);
    expect(view.detail).not.toContain('parent channel');
    expect(view.detail).not.toContain('retired');
    expect(view.detail).toBe("The update couldn't finish. Check again when you're ready.");
  }
});

test('a self-retrying neutral check failure is not the top attention indicator', () => {
  const neutral = desktopStatus({ phase: 'error', actions: ['check'], error: { code: 'check_unavailable', message: "Couldn't check for updates. Check your connection, then try again." } });
  expect(desktopUpdateIndicator([neutral])).toBeNull();
  const ready = desktopStatus({ phase: 'ready', target: '0.2.4', actions: ['restart'] });
  expect(desktopUpdateIndicator([neutral, ready])?.label).toBe('Update ready');
  const failed = desktopStatus({ phase: 'error', actions: ['check'], error: { code: 'verification_failed', message: 'Signature verification failed' } });
  expect(desktopUpdateIndicator([neutral, failed])?.label).toBe('Update needs attention');
});

test('real update failures keep the red attention state without adapter internals', () => {
  for (const error of [
    { code: 'verification_failed', message: 'Signature verification failed' },
    { code: 'disk', message: 'Not enough disk space' },
    { code: 'pre_handoff', message: 'Desktop update adapter could not complete the operation' },
    { code: 'update_failed', message: 'Desktop update adapter could not complete the operation' },
  ]) {
    const view = desktopUpdateView(desktopStatus({ phase: 'error', actions: ['check', 'retry'], error }));
    expect(view.tone).toBe('bad');
    expect(view.label).toBe('Update needs attention');
    expect(view.detail).not.toContain('Desktop update adapter');
  }
  expect(desktopUpdateView(desktopStatus({ phase: 'recovery-failed', actions: [] })).tone).toBe('bad');
});
