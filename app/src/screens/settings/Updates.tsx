import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Checkbox, Disclosure } from "../../ds/Controls";
import type { UpdateStatus } from "../../../../src/update/desktop/types";
import { desktopUpdateView, desktopUpdateFeedback, desktopAdoptionConfirmation, updateIntent, type DesktopAction } from "../../../../src/view-model/updates";
import { useActions } from "../../data/action-context";
import { Button } from "../../ds/Button";
import { StatusPill } from "../../ds/StatusPill";
import { useDialogs } from "../../ds/useDialogs";
import { ErrorMessage, useTaskContext } from "../task-shared";
import type { ConfigData } from "../../model/strategy";
import type { SettingsData } from "./General";
import { Feedback, ResourceState, Section, time, useOperation, useResource } from "./shared";

export function DesktopUpdate({ status, showIdentity = false }: { status: UpdateStatus; showIdentity?: boolean }) {
  const { state } = useTaskContext(), runner = useActions(), dialogs = useDialogs();
  const intent = useMemo(() => updateIntent(), []), pending = useRef(false), group = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(), [feedback, setFeedback] = useState<{action:DesktopAction;result:UpdateStatus}>();
  const available = { ...status, actions: status.actions.filter(action => state.features.ops.has(`desktop.update.${action}`)) };
  const view = desktopUpdateView(available);
  // Read before commit: was focus inside this update when its primary action changed?
  const focusedBefore = typeof document !== "undefined" && !!group.current?.contains(document.activeElement);
  const focusOnChange = useRef(false);
  focusOnChange.current = focusedBefore;
  useEffect(() => {
    // The primary button is remounted per action, so a repeated Enter never runs the new action (e.g. cancel after download).
    if (focusOnChange.current && !group.current?.contains(document.activeElement)) group.current?.focus();
  }, [view.action]);
  const message = feedback ? desktopUpdateFeedback(feedback.action,feedback.result,status) : null;
  async function run(action: DesktopAction, autoDownload?: boolean) {
    if (pending.current || !state.connected) return;
    pending.current = true;
    try {
      if (action === "restart" && !await dialogs.confirm(`Restart pacer to install ${status.target}? Active work and sessions will be allowed to finish first.`, "Restart to update", "Restart to update")) return;
      if (action === "adopt" && !await dialogs.confirm(desktopAdoptionConfirmation(available), "Use the desktop service", "Use the desktop service")) return;
      const request = intent(available, action, { autoDownload });
      setBusy(true); setError(undefined); setFeedback(undefined);
      const result = await runner.run(`desktop:${status.installationId}`, request);
      if (result.status === "error") setError(new Error(`${result.message}${result.hint ? ` · ${result.hint}` : ""}`));
      else if (result.status === "done") {
        const response = runner.result(`desktop:${status.installationId}`) as UpdateStatus | undefined;
        if (response?.installationId === status.installationId && Number.isSafeInteger(response.revision)) setFeedback({action,result:response});
      }
    } catch (error) { setError(error); }
    finally {
      pending.current = false; setBusy(false);
      // A completed action can replace its button; keep keyboard users in this update instead of the page top.
      queueMicrotask(() => { if (!group.current?.contains(document.activeElement)) group.current?.focus(); });
    }
  }
  const unavailable = busy || !state.connected;
  const name = `pacer desktop ${status.current}${showIdentity ? ` (${status.installationId.slice(0, 8)})` : ""}`;
  return <div className="u3-desktop-update" role="group" aria-label={name} aria-busy={busy} ref={group} tabIndex={-1}>
    <div className="u3-row"><strong>pacer desktop · {status.current}{status.target && status.target !== status.current && ` → ${status.target}`}</strong><StatusPill status={view}/></div>
    {/* Only the phase is announced; progress percentages in the detail would be read on every change. */}
    <div role="status" aria-live="polite"><span className="sr-only">{view.label}</span>{busy && <p>Sending request…</p>}{message && <p>{message}</p>}</div>
    <p>{view.detail}</p>
    {showIdentity && <Disclosure summary="Installation details"><code>{status.installationId}</code></Disclosure>}
    {status.adoption && <div role="group" aria-label="Service change"><p>Current service · <code>{status.adoption.currentServiceExecutable}</code></p><p>Desktop service · <code>{status.adoption.replacementServiceExecutable}</code></p><p>{status.adoption.serviceLabel} · port {status.adoption.port}</p>{status.adoption.resultingInstallationId && <p>Installation · <code>{status.adoption.previousInstallationId}</code> → <code>{status.adoption.resultingInstallationId}</code></p>}{status.adoption.blockers.length > 0 && <ul aria-label="Work holding the service change">{status.adoption.blockers.map(blocker => <li key={`${blocker.kind}:${blocker.id}`}>{blocker.label}</li>)}</ul>}{status.adoption.error && <p>{status.adoption.error.message}</p>}</div>}
    {status.blockers.length > 0 && <ul aria-label="Work holding the update">{status.blockers.map(blocker => <li key={`${blocker.kind}:${blocker.id}`}>{blocker.label || ({ task: "Running task", session: "Interactive session", launch: "Starting work", operation: "Operation in progress" }[blocker.kind])}</li>)}</ul>}
    {status.error?.hint && <p>{status.error.hint}</p>}
    <p className="u3-muted">Last checked · {time(status.checkedAt)}</p>
    {status.releaseNotes && <Disclosure summary={`What's new in ${status.target}`}><p className="u3-release-notes">{status.releaseNotes}</p></Disclosure>}
    <div className="u3-actions">{view.action && <Button key={view.action} variant="primary" aria-disabled={unavailable} onClick={() => void run(view.action!)}>{view.primary}</Button>}{view.action !== "check" && available.actions.includes("check") && <Button aria-disabled={unavailable} onClick={() => void run("check")}>Check for updates</Button>}</div>
    {available.actions.includes("configure") ? <label className="pc-checkbox"><span>Download updates automatically <small className="u3-muted">Restart only with your permission</small></span><Checkbox className="pc-checkbox__input" checked={status.autoDownload} disabled={busy || !state.connected || !available.actions.includes("configure")} onChange={event => void run("configure", event.currentTarget.checked)}/></label> : status.ownership === "managed" && ["idle", "checking", "downloading", "ready", "complete", "error"].includes(status.phase) ? <p className="u3-muted">Automatic downloads are {status.autoDownload ? "on" : "off"}.</p> : null}
    {!state.connected && <p role="status">Reconnecting… update status may be out of date.</p>}
    <ErrorMessage error={error}/>{dialogs.dialog}
  </div>;
}

export function UpdatesSection({ initialData }: { initialData?: SettingsData["updates"] }) {
  const { state } = useTaskContext();
  const updates = state.snapshot?.desktopUpdates;
  return updates?.length ? <DesktopUpdates updates={updates}/> : <LegacyUpdatesSection initialData={initialData}/>;
}
function DesktopUpdates({ updates }: { updates: UpdateStatus[] }) {
  return <Section id="updates" title="Updates">{updates.map(status => <DesktopUpdate key={status.installationId} status={status} showIdentity={updates.length > 1}/>)}</Section>;
}
function LegacyUpdatesSection({initialData}:{initialData?:SettingsData['updates']}) {
 const dialogs=useDialogs();
 const query=useResource('update.check',{},initialData),config=useResource<ConfigData>('config.get'),action=useOperation(query.reload);
 return <Section id="updates" title="Updates" actions={<Button disabled={action.busy} onClick={()=>void action.run('update.check',{force:true})}>Check now</Button>}>{dialogs.dialog}<ResourceState resource={query}>{query.data&&<><p>Version {query.data.current} · {query.data.available?`Update available: ${query.data.latest}`:query.data.latest?'Up to date':'Not checked'}</p>{query.data.error&&<p role="status">{query.data.error}</p>}{query.data.disabled&&<p>Automatic update checks are off.</p>}{query.data.available&&<Button disabled={action.busy} onClick={async()=>{if(await dialogs.confirm('Update pacer and restart the service?','Update and restart','Update and restart'))void action.run('update.apply',{});}}>Update and restart</Button>}</>}</ResourceState><label className="pc-checkbox"><span>Check for updates <small className="u3-muted">Once a day, in the background</small></span><Checkbox className="pc-checkbox__input"  aria-label="Check for updates" checked={config.data?.keys.update_check?.value!==false} disabled={!config.data||action.busy} onChange={e=>void action.run('config.set',{key:'update_check',value:e.currentTarget.checked})}/></label><ResourceState resource={config}><span/></ResourceState><Feedback action={action}/></Section>;
}
