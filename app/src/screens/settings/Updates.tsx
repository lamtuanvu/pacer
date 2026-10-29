import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Checkbox, Disclosure, Switch } from "../../ds/Controls";
import type { UpdateStatus } from "../../../../src/update/desktop/types";
import { desktopUpdateView, desktopUpdateFeedback, desktopAdoptionConfirmation, updateIntent, type DesktopAction } from "../../../../src/view-model/updates";
import { useActions } from "../../data/action-context";
import { Button, ButtonLink } from "../../ds/Button";
import { StatusPill } from "../../ds/StatusPill";
import { useDialogs } from "../../ds/useDialogs";
import { ErrorMessage, useTaskContext } from "../task-shared";
import type { ConfigData } from "../../model/strategy";
import { DesktopUpdateConnection } from "./DesktopUpdateConnection";
import { desktopHost, readDesktopVersion, readDesktopUpdateConnection, type DesktopUpdateConnection as Connection } from "../../data/desktop";
import { updateModel } from "../../model/settings";
import { desktopUpdateModel } from "../../../../src/view-model/updates";
import { SettingRow } from "../../ds/SettingRow";
import { Feedback, ResourceState, time, useOperation, useResource, useSettingsStyles } from "./shared";
import { RunningWork } from "./RunningWork";

/** Offers a line break after each `/`, so long paths wrap between segments rather than mid-name. */
function PathText({ path }: { path: string }) {
  return <>{path.split(/(?<=\/)/).map((part, index) => <>{index > 0 && <wbr/>}{part}</>)}</>;
}

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
    {status.adoption && <div role="group" aria-label="Service change"><p>Current service · <code><PathText path={status.adoption.currentServiceExecutable}/></code></p><p>Desktop service · <code><PathText path={status.adoption.replacementServiceExecutable}/></code></p><p>{status.adoption.serviceLabel} · port {status.adoption.port}</p>{status.adoption.resultingInstallationId && <p>Installation · <code>{status.adoption.previousInstallationId}</code> → <code>{status.adoption.resultingInstallationId}</code></p>}{status.adoption.blockers.length > 0 && <ul aria-label="Work holding the service change">{status.adoption.blockers.map(blocker => <li key={`${blocker.kind}:${blocker.id}`}>{blocker.label}</li>)}</ul>}{status.adoption.error && <p>{status.adoption.error.message}</p>}</div>}
    {status.blockers.length > 0 && <ul aria-label="Work holding the update">{status.blockers.map(blocker => <li key={`${blocker.kind}:${blocker.id}`}>{blocker.label || ({ task: "Running task", session: "Interactive session", launch: "Starting work", operation: "Operation in progress" }[blocker.kind])}</li>)}</ul>}
    {status.error?.hint && <p>{status.error.hint}</p>}
    <p className="u3-muted">Last checked {time(status.checkedAt)}</p>
    <a className="pc-inline-link" href={`https://github.com/lamtuanvu/pacer/releases/${status.target && /^\d+\.\d+\.\d+$/.test(status.target) ? `tag/v${status.target}` : "latest"}`}>Release notes</a>
    {status.releaseNotes && <Disclosure summary={`What's new in ${status.target}`}><p className="u3-release-notes">{status.releaseNotes}</p></Disclosure>}
    <div className="u3-actions">{view.action && <Button key={view.action} variant="primary" aria-disabled={unavailable} onClick={() => void run(view.action!)}>{view.primary}</Button>}{view.action !== "check" && available.actions.includes("check") && <Button aria-disabled={unavailable} onClick={() => void run("check")}>Check for updates</Button>}</div>
    {available.actions.includes("configure") ? <label className="pc-checkbox"><span>Download updates automatically <small className="u3-muted">Restart only with your permission</small></span><Checkbox className="pc-checkbox__input" checked={status.autoDownload} disabled={busy || !state.connected || !available.actions.includes("configure")} onChange={event => void run("configure", event.currentTarget.checked)}/></label> : status.ownership === "managed" && ["idle", "checking", "downloading", "ready", "complete", "error"].includes(status.phase) ? <p className="u3-muted">Automatic downloads are {status.autoDownload ? "on" : "off"}.</p> : null}
    {!state.connected && <p role="status">Reconnecting… update status may be out of date.</p>}
    <ErrorMessage error={error}/>{dialogs.dialog}
  </div>;
}

export function UpdatesSection({ initialData, initialConfig }: { initialData?: UpdateReport; initialConfig?: ConfigData }) {
  useSettingsStyles();
  const { state } = useTaskContext();
  const updates = state.snapshot?.desktopUpdates;
  return updates?.length ? <DesktopUpdates updates={updates} serviceVersion={state.version ?? initialData?.current} initialConfig={initialConfig}/> : <LegacyUpdatesSection initialData={initialData} initialConfig={initialConfig}/>;
}
function DesktopUpdates({ updates, serviceVersion, initialConfig }: { updates: UpdateStatus[]; serviceVersion?: string | null; initialConfig?: ConfigData }) {
  return <section id="updates" className="pc-preferences-section" aria-labelledby="updates-h"><h2 id="updates-h" className="pc-settings-board__label">Updates</h2>{serviceVersion && <p>Service {serviceVersion}</p>}<RunningWork/>{updates.map(status => <DesktopUpdate key={status.installationId} status={status} showIdentity={updates.length > 1}/>) }<AutomaticUpdateCheck initialData={initialConfig} checkedAt={updates.reduce((last, status) => Math.max(last, status.checkedAt ?? 0), 0) || undefined}/></section>;
}
export interface UpdateReport {
  current: string;
  latest: string | null;
  available: boolean;
  error?: string;
  disabled?: boolean;
  checkedAt?: number;
}

export function DesktopVersionRow({version, loading, report}: {
  version: string | null;
  loading: boolean;
  report?: UpdateReport;
}) {
  const status = desktopUpdateModel(version, report);
  const download = status.canUpdate || !version;
  const release = report?.latest && /^\d+\.\d+\.\d+$/.test(report.latest)
    ? `tag/v${report.latest}` : 'latest';
  return <div>
    <p role="status">Desktop app{version ? ` ${version}` : ''} · {loading ? 'Reading version…' : status.label}</p>
    {!loading && download && <>
      <ButtonLink href={`https://github.com/lamtuanvu/pacer/releases/${release}`}>Download desktop app</ButtonLink>
      <p className="u3-muted">Download the desktop build for your computer, replace the installed app, then quit and reopen pacer. Updating the service does not update the desktop app.</p>
    </>}
  </div>;
}

function LegacyUpdatesSection({initialData, initialConfig}: {initialData?: UpdateReport; initialConfig?: ConfigData}) {
  const dialogs = useDialogs();
  const query = useResource('update.check', {}, initialData);
  const action = useOperation(query.reload);
  const [native] = useState(() => !!desktopHost().__TAURI__);
  const [desktop, setDesktop] = useState<{version:string|null;loading:boolean}>({version:null,loading:true});
  useEffect(() => {
    if (!native) return;
    let active = true;
    void readDesktopVersion().then(
      version => { if (active) setDesktop({version,loading:false}); },
      () => { if (active) setDesktop({version:null,loading:false}); },
    );
    return () => { active = false; };
  }, [native]);
  const [connection, setConnection] = useState<Connection | null>({ state: "connecting", reason: null });
  useEffect(() => {
    if (!native) return;
    let active = true, reading = false;
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try { const value = await readDesktopUpdateConnection(); if (active) setConnection(value); }
      catch { if (active) setConnection(null); }
      finally { reading = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => { active = false; clearInterval(timer); };
  }, [native]);
  const service = updateModel(query.data, false);
  return <section id="updates" className="pc-preferences-section" aria-labelledby="updates-h"><h2 id="updates-h" className="pc-settings-board__label">Updates</h2>
    {dialogs.dialog}
    {native && <>
      <p>Desktop app{desktop.version ? ` ${desktop.version}` : ""}</p>
      <DesktopUpdateConnection connection={connection}/>
      <Disclosure summary="Manual desktop update options"><DesktopVersionRow {...desktop} report={query.data}/></Disclosure>
    </>}
    <ResourceState resource={query}>{query.data && <SettingRow variant="board" label={`pacer ${query.data.current}`} description={<span role="status">{query.data.disabled ? "Automatic checks are unavailable in this session" : service.label}{query.data.error ? ` · ${query.data.error}` : ""}</span>}>
      <div className="u3-actions">
        {service.canUpdate && <Button size="sm" variant="primary" busy={action.busy} onClick={async () => {
          if (await dialogs.confirm('Update the service and restart it? The desktop app is updated separately.', 'Update service', 'Update service and restart')) {
            void action.run('update.apply', {});
          }
        }}>Install {query.data.latest}</Button>}
        <a className="pc-inline-link" href={`https://github.com/lamtuanvu/pacer/releases/${query.data.latest && /^\d+\.\d+\.\d+$/.test(query.data.latest) ? `tag/v${query.data.latest}` : "latest"}`}>Release notes</a>
        <Button size="sm" busy={action.busy} onClick={() => void action.run('update.check', {force:true})}>Check now</Button>
      </div>
    </SettingRow>}</ResourceState>
<RunningWork/>
        <AutomaticUpdateCheck busy={action.busy} initialData={initialConfig} checkedAt={query.data?.checkedAt}/>
    <Feedback action={action}/>
  </section>;
}

function AutomaticUpdateCheck({ busy = false, initialData, checkedAt }: { busy?: boolean; initialData?: ConfigData; checkedAt?: number }) {
  const config = useResource<ConfigData>("config.get", {}, initialData), action = useOperation(config.reload);
  return <><SettingRow variant="board" label="Check automatically" description={`Once a day, in the background.${checkedAt ? ` Last checked ${time(checkedAt)}.` : ""}`}><Switch size="sm" aria-label="Check automatically" checked={config.data?.keys.update_check?.value !== false} disabled={!config.data || busy || action.busy} onChange={e => void action.run("config.set", {key:"update_check",value:e.currentTarget.checked})}/></SettingRow><ResourceState resource={config}><span/></ResourceState><Feedback action={action}/></>;
}
