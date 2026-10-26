import { useState } from "preact/hooks";
import type { PluginInfo, DoctorReport } from "../../../../src/plugins/registry";
import { pluginStatus } from "../../../../src/view-model/words";
import { capabilityCopy, contributionCopy } from "../../../../src/view-model/plugin-permissions";
import { Button } from "../../ds/Button";
import { Disclosure } from "../../ds/Controls";
import { Dialog } from "../../ds/Dialog";
import { StatusPill } from "../../ds/StatusPill";
import { useDialogs } from "../../ds/useDialogs";
import { useTaskContext } from "../task-shared";
import { Feedback, ResourceState, Section, useOperation, useResource } from "./shared";

export type PluginRow = PluginInfo;
type Action = "enable" | "grant" | "disable" | "remove" | "doctor";

function PermissionDetails({ plugin }: { plugin: PluginRow }) {
  return <Disclosure summary="Technical capability IDs and scopes">
    <p>Integration IDs: {plugin.contributes.length ? plugin.contributes.map(name => <code key={name}>{name} </code>) : "None"}</p>
    <ul>{plugin.capabilities.map(capability => <li key={capability.name}><code>{capability.name}</code>{capability.scopes?.length ? <>: {capability.scopes.map(scope => <code key={scope}>{scope} </code>)}</> : null}</li>)}</ul>
  </Disclosure>;
}

/** Only the authenticated host route is used. The opaque-origin frame has no host bridge. */
export function PluginRows({ plugins, busy, selected, report = null, checkError = null, checking = null, onAction, onOpen }: {
  plugins: PluginRow[]; busy: boolean; selected: string | null;
  report?: DoctorReport | null; checkError?: {id: string; message: string} | null; checking?: string | null;
  onAction: (id: string, action: Action) => void; onOpen: (id: string | null) => void;
}) {
  return <div className="u3-plugin-list">{plugins.map(plugin => {
    const granted = plugin.bundled || !!plugin.expectedConsent && plugin.grant?.consent === plugin.expectedConsent;
    const open = selected === plugin.id && plugin.surface?.available === true;
    return <article className="pc-card u3-plugin-card" key={plugin.id} aria-label={`Plugin ${plugin.id}`}>
      <div className="u3-plugin-top"><div className="u3-plugin-heading"><strong title={plugin.id}>{plugin.id}</strong><span className="u3-muted">{plugin.publisher || "Publisher unavailable"} · {plugin.version || "Version unavailable"}</span></div><StatusPill status={pluginStatus(plugin.state)} /></div>
      <p className="u3-muted">{plugin.tier === "commercial" ? "Commercial · License status unavailable" : "Free"}{plugin.bundled ? " · Bundled with pacer" : " · Installed"}</p>
      {!plugin.bundled && plugin.grant && !plugin.grant.consent && <p role="status">This plugin's earlier permission needs review before it can run.</p>}
      {plugin.error && plugin.state !== "needs_grant" && <p role="status">This plugin needs attention. Run a check for details.</p>}
      {plugin.surface && !plugin.surface.available && <p className="u3-muted">Panel unavailable while this plugin is disabled or needs attention.</p>}
      <Disclosure summary="Capabilities and permissions">
        <p>What it adds: {plugin.contributes.length ? plugin.contributes.map(contributionCopy).join(", ") : "No integrations"}</p>
        <p>Access requested: {plugin.capabilities.length ? plugin.capabilities.map(capabilityCopy).join("; ") : "No additional access"}</p>
        <p>Permission: {granted ? "Granted for this version" : "Approval required to enable"}</p>
        <PermissionDetails plugin={plugin} />
        {plugin.error && <Disclosure summary="Technical plugin error"><code>{plugin.error}</code></Disclosure>}
      </Disclosure>
      <div className="u3-actions">
        {plugin.enabled ? <Button size="sm" disabled={busy} onClick={() => onAction(plugin.id, "disable")}>Disable</Button>
          : <Button size="sm" disabled={busy || plugin.state === "refused"} onClick={() => onAction(plugin.id, granted || plugin.bundled ? "enable" : "grant")}>{granted || plugin.bundled ? "Enable" : "Allow and enable"}</Button>}
        <Button size="sm" disabled={busy || !!checking} busy={checking === plugin.id} onClick={() => onAction(plugin.id, "doctor")}>Run check</Button>
        {!plugin.bundled && <Button size="sm" variant="danger" disabled={busy} onClick={() => onAction(plugin.id, "remove")}>Remove</Button>}
        {plugin.surface?.available && <Button size="sm" aria-label={`${open ? "Close" : "Open"} panel for ${plugin.id}`} aria-expanded={open} disabled={busy} onClick={() => onOpen(open ? null : plugin.id)}>{open ? "Close panel" : "Open panel"}</Button>}
      </div>
      {checking === plugin.id && <p role="status">Checking {plugin.id}…</p>}
      {report?.id === plugin.id && <><p role="status">Check: {report.ok ? "Passed" : "Needs attention"}.</p>{report.error && <Disclosure summary="Technical check details"><code>{report.error}</code></Disclosure>}</>}
      {checkError?.id === plugin.id && <p role="alert">{checkError.message}</p>}
      {open && <div className="u3-plugin-frame"><iframe title={`${plugin.id} plugin panel`} src={`/app/plugins/${encodeURIComponent(plugin.surface!.prefix)}/`} sandbox="allow-scripts" referrerPolicy="no-referrer" loading="lazy" /></div>}
    </article>;
  })}</div>;
}

export function PluginsSection() {
  const { api, state } = useTaskContext();
  const query = useResource<{ plugins: PluginRow[] }>("plugin.list");
  const action = useOperation(query.reload, { notifySuccess: false });
  const dialogs = useDialogs();
  const [selected, setSelected] = useState<string | null>(null);
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [checkError, setCheckError] = useState<{id: string; message: string} | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [grantRequest, setGrantRequest] = useState<PluginRow | null>(null);
  const [grantBusy, setGrantBusy] = useState(false);
  const [grantError, setGrantError] = useState<string | null>(null);
  const grant = async () => {
    const reviewed = grantRequest;
    if (!reviewed?.expectedConsent || grantBusy) return;
    setGrantBusy(true); setGrantError(null); setReport(null); setCheckError(null);
    try {
      await api.call("plugin.enable", { id: reviewed.id, grant: true, expectedConsent: reviewed.expectedConsent });
      setGrantRequest(null); query.reload();
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "conflict") {
        try {
          const current = await api.call<{plugins: PluginRow[]}>("plugin.list", {});
          query.setData(current);
          setGrantRequest(current.plugins.find(plugin => plugin.id === reviewed.id) ?? null);
          setGrantError("Plugin permissions changed. Review the new request before allowing access.");
        } catch (refreshError) {
          setGrantRequest(null);
          setGrantError(refreshError instanceof Error ? refreshError.message : "Could not refresh plugin permissions.");
          query.reload();
        }
      } else setGrantError(error instanceof Error ? error.message : "Could not enable the plugin.");
    } finally { setGrantBusy(false); }
  };
  const run = async (id: string, choice: Action) => {
    const plugin = query.data?.plugins.find(row => row.id === id);
    if (!plugin || action.busy) return;
    if (choice === "grant") {
      setGrantError(null);
      setGrantRequest(plugin);
      return;
    }
    if (choice === "remove" && !await dialogs.confirm(`Remove ${id} and its installed files? This also clears its permission grant.`, "Remove plugin", "Remove plugin")) return;
    if (choice === "doctor") {
      setCheckError(null); setReport(null); setChecking(id);
      try { const result = await api.call<{reports: DoctorReport[]}>("plugin.doctor", { id }); setReport(result.reports[0] ?? null); query.reload(); }
      catch (error) { setCheckError({id, message: error instanceof Error ? error.message : "Plugin check failed."}); }
      finally { setChecking(null); }
      return;
    }
    setReport(null); setCheckError(null);
    const result = await action.run(`plugin.${choice}`, { id });
    if (result && (choice === "disable" || choice === "remove")) setSelected(current => current === id ? null : current);
  };
  return <Section id="plugins" title="Plugins" detail="Review installed plugins and their permissions. Plugin panels run in an isolated frame.">
    {dialogs.dialog}
    {grantRequest && <Dialog title="Allow plugin access" close={() => setGrantRequest(null)}>
      <div className="pc-form">
        <p>Allow <strong>{grantRequest.id}</strong> version {grantRequest.version} to:</p>
        {grantRequest.capabilities.length ? <ul>{grantRequest.capabilities.map(capability => <li key={capability.name}>{capabilityCopy(capability)}</li>)}</ul> : <p>Use no additional access.</p>}
        <PermissionDetails plugin={grantRequest} />
        {grantError && <p role="alert">{grantError}</p>}
        <div className="row-actions"><Button autoFocus onClick={() => { setGrantRequest(null); setGrantError(null); }}>Cancel</Button><Button variant="primary" disabled={grantBusy || action.busy || !state.connected || !grantRequest.expectedConsent} onClick={() => void grant()}>Allow and enable</Button></div>
      </div>
    </Dialog>}
    <ResourceState resource={query}>
      {query.data && (query.data.plugins.length ? <PluginRows plugins={query.data.plugins} busy={action.busy || !state.connected} selected={selected} report={report} checkError={checkError} checking={checking} onAction={(id, choice) => void run(id, choice)} onOpen={setSelected} /> : <p>No plugins are installed.</p>)}
    </ResourceState>
    {!state.connected && <p role="status">Reconnecting. Plugin actions will be available when the service returns.</p>}
    {!grantRequest && grantError && <p role="alert">{grantError}</p>}
    <Feedback action={action} />
  </Section>;
}
