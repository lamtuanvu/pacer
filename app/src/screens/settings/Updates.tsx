import { useMemo, useRef, useState } from "preact/hooks";
import type { UpdateStatus } from "../../../../src/update/desktop/types";
import { desktopUpdateView, desktopUpdateFeedback, updateIntent, type DesktopAction } from "../../../../src/view-model/updates";
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
  const intent = useMemo(() => updateIntent(), []), pending = useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(), [feedback, setFeedback] = useState<{action:DesktopAction;result:UpdateStatus}>();
  const available = { ...status, actions: status.actions.filter(action => state.features.ops.has(`desktop.update.${action}`)) };
  const view = desktopUpdateView(available);
  const message = feedback ? desktopUpdateFeedback(feedback.action,feedback.result,status) : null;
  async function run(action: DesktopAction, autoDownload?: boolean) {
    if (pending.current || !state.connected) return;
    pending.current = true;
    try {
      if (action === "restart" && !await dialogs.confirm(`Restart pacer to install ${status.target}? Active work and sessions will be allowed to finish first.`, "Restart to update", "Restart to update")) return;
      if (action === "adopt" && !await dialogs.confirm("Use the desktop-managed service for this installation? Your tasks, accounts and settings are preserved. The external service will no longer manage this desktop.", "Use the desktop service", "Use desktop service")) return;
      const request = intent(available, action, { autoDownload });
      setBusy(true); setError(undefined); setFeedback(undefined);
      const result = await runner.run(`desktop:${status.installationId}`, request);
      if (result.status === "error") setError(new Error(`${result.message}${result.hint ? ` · ${result.hint}` : ""}`));
      else if (result.status === "done") {
        const response = runner.result(`desktop:${status.installationId}`) as UpdateStatus | undefined;
        if (response?.installationId === status.installationId && Number.isSafeInteger(response.revision)) setFeedback({action,result:response});
      }
    } catch (error) { setError(error); }
    finally { pending.current = false; setBusy(false); }
  }
  return <div className="u3-desktop-update" aria-label={`Desktop ${status.current}`} aria-busy={busy}>
    <div className="u3-row"><strong>pacer desktop · {status.current}{status.target && status.target !== status.current && ` → ${status.target}`}</strong><StatusPill status={view}/></div>
    <div role="status" aria-live="polite"><p>{view.detail}</p>{busy && <p>Sending request…</p>}{message && <p>{message}</p>}</div>
    {showIdentity && <details className="pc-disclosure"><summary>Installation details</summary><code>{status.installationId}</code></details>}
    {status.blockers.length > 0 && <ul aria-label="Work holding the update">{status.blockers.map(blocker => <li key={`${blocker.kind}:${blocker.id}`}>{blocker.label || ({ task: "Running task", session: "Interactive session", launch: "Starting work", operation: "Operation in progress" }[blocker.kind])}</li>)}</ul>}
    {status.error?.hint && <p>{status.error.hint}</p>}
    <p className="u3-muted">Last checked · {time(status.checkedAt)}</p>
    {status.releaseNotes && <details className="pc-disclosure"><summary>What's new in {status.target}</summary><p className="u3-release-notes">{status.releaseNotes}</p></details>}
    <div className="u3-actions">{view.action && <Button variant="primary" disabled={busy || !state.connected} onClick={() => void run(view.action!)}>{view.primary}</Button>}{view.action !== "check" && available.actions.includes("check") && <Button disabled={busy || !state.connected} onClick={() => void run("check")}>Check for updates</Button>}</div>
    {available.actions.includes("configure") ? <label className="pc-checkbox"><span>Download updates automatically <small className="u3-muted">Restart only with your permission</small></span><input className="pc-checkbox__input" type="checkbox" checked={status.autoDownload} disabled={busy || !state.connected || !available.actions.includes("configure")} onChange={event => void run("configure", event.currentTarget.checked)}/></label> : <p className="u3-muted">Automatic downloads are {status.autoDownload ? "on" : "off"}.</p>}
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
  const action = useOperation();
  return <Section id="updates" title="Updates & plugin">{updates.map(status => <DesktopUpdate key={status.installationId} status={status} showIdentity={updates.length > 1}/>)}<div className="u3-row"><div><strong>Orca plugin</strong><p className="u3-muted">Install the panel, then enable it in Orca’s plugin settings.</p></div><Button disabled={action.busy} onClick={() => void action.run("plugin.install", {})}>Install Orca panel</Button></div><Feedback action={action}/></Section>;
}
function LegacyUpdatesSection({initialData}:{initialData?:SettingsData['updates']}) {
 const dialogs=useDialogs();
 const query=useResource('update.check',{},initialData),config=useResource<ConfigData>('config.get'),action=useOperation(query.reload);
 return <Section id="updates" title="Updates & plugin" actions={<Button disabled={action.busy} onClick={()=>void action.run('update.check',{force:true})}>Check now</Button>}>{dialogs.dialog}<ResourceState resource={query}>{query.data&&<><p>Version {query.data.current} · {query.data.available?`Update available: ${query.data.latest}`:query.data.latest?'Up to date':'Not checked'}</p>{query.data.error&&<p role="status">{query.data.error}</p>}{query.data.disabled&&<p>Automatic update checks are off.</p>}{query.data.available&&<Button disabled={action.busy} onClick={async()=>{if(await dialogs.confirm('Update pacer and restart the service?','Update and restart','Update and restart'))void action.run('update.apply',{});}}>Update and restart</Button>}</>}</ResourceState><label className="pc-checkbox"><span>Check for updates <small className="u3-muted">Once a day, in the background</small></span><input className="pc-checkbox__input" type="checkbox" aria-label="Check for updates" checked={config.data?.keys.update_check?.value!==false} disabled={!config.data||action.busy} onChange={e=>void action.run('config.set',{key:'update_check',value:e.currentTarget.checked})}/></label><ResourceState resource={config}><span/></ResourceState><div className="u3-row"><div><strong>Orca plugin</strong><p className="u3-muted">Install the panel, then enable it in Orca’s plugin settings.</p></div><Button disabled={action.busy} onClick={()=>void action.run('plugin.install',{})}>Install Orca panel</Button></div><Feedback action={action}/></Section>;
}
