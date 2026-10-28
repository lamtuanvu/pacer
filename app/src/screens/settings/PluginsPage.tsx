import { useState } from "preact/hooks";
import type { PluginInfo, SurfaceInfo, DoctorReport } from "../../../../src/plugins/registry";
import { Page, LoadingState } from "../../ds/Patterns";
import { DensityContext } from "../../ds/Density";
import { ButtonLink } from "../../ds/Button";
import { Switch } from "../../ds/Controls";
import { Pill } from "../../ds/Pill";
import { Icon } from "../../ds/icons";
import { ActionMenu } from "../../ds/ActionMenu";
import { hrefFor, routes } from "../../router";
import { ErrorMessage } from "../task-shared";
import { useResource, Feedback } from "./shared";
import { usePluginToggle } from "./Plugins";
import { pluginIcon, pluginAdditions, capabilityWords, attentionState } from "./plugin-presentation";
import { usePluginSettingsStyles } from "./plugin-styles";
const places = [["Settings pages", "Listed under Extend, marked “plugin”"], ["Activity bar", "Icons under Plugins on the left"], ["Side panels", "Sections on the left, tabs on the right"], ["Routing engines", "A choice method in Dispatcher"], ["Usage readers", "Budgets for more agents"]];
export function PluginsPage({ initialData, initialSurfaces }: { initialData?: {plugins:PluginInfo[]}; initialSurfaces?: {surfaces:SurfaceInfo[]} }) {
  usePluginSettingsStyles();
  const resource = useResource("plugin.list", {}, initialData), surfaces = useResource("plugin.ui.list", {}, initialSurfaces);
  const {action, dialogs, busy, toggle} = usePluginToggle(resource.reload, resource.loading);
  const [reports, setReports] = useState<Record<string,string>>({});
  async function doctor(plugin: PluginInfo) {
    await action.run("plugin.doctor", {id:plugin.id}, (data: {reports:DoctorReport[]}) => {
      setReports(old => ({...old,[plugin.id]:data.reports.map(report => report.ok ? "Checks: ok" : report.error ?? report.needs ?? "Checks need attention.").join(" · ")})); resource.reload();
    });
  }
  async function remove(plugin: PluginInfo) {
    if (await dialogs.confirm(`Remove the plugin ${plugin.id}? Its settings will also be removed.`, "Remove plugin", "Remove")) await action.run("plugin.remove", {id:plugin.id}, resource.reload);
  }
  return <DensityContext.Provider value="settings"><Page width="full" className="u3-settings u3-settings-page"><div className="pc-plugin-settings">
    <header className="pc-settings-board__header"><h1>Plugins</h1><p>Add capabilities to pacer. Each plugin runs in its own process and says exactly what it adds and what it may access.</p></header>
    <section aria-label="Installed plugins" className="pc-plugin-installed">
      {resource.data && <span className="pc-plugin-installed__count">Installed · {resource.data.plugins.length}</span>}
      {!resource.data && !resource.error && <LoadingState label="Loading plugins…"/>}<ErrorMessage error={resource.error}/>
      {resource.data?.plugins.length === 0 && <p>No plugins installed.</p>}
      {resource.data?.plugins.map(plugin => {
        const adds = pluginAdditions(plugin), may = capabilityWords(plugin), page = plugin.enabled && surfaces.data?.surfaces.some(s => s.plugin === plugin.id && s.surface === "settings" && s.visible);
        const status = plugin.state === "failing" ? {tone:"bad" as const,label:"Failing"} : plugin.state === "refused" ? {tone:"bad" as const,label:"Refused"} : plugin.state === "needs_grant" ? {tone:"warn" as const,label:"Needs permission"} : !plugin.enabled ? {tone:"neutral" as const,label:"Off"} : undefined;
        return <article key={plugin.id} className={`pc-plugin-card${attentionState(plugin) ? " pc-plugin-card--attention" : ""}`} aria-label={plugin.id}>
          <span className="pc-plugin-card__icon" aria-hidden="true"><Icon name={pluginIcon(plugin.id,surfaces.data?.surfaces ?? [])}/></span>
          <div className="pc-plugin-card__copy"><div className="pc-plugin-card__name"><b>{plugin.id}</b>{plugin.bundled || plugin.version === "bundled" ? <><Pill tone="neutral">Built in</Pill><span className="pc-settings-board__caption">{plugin.publisher}</span></> : <span className="pc-settings-board__caption">{plugin.version} · {plugin.publisher}</span>}{status && <Pill tone={status.tone}>{status.label}</Pill>}</div>
            {plugin.error && <span className="pc-plugin-card__error">{plugin.error}</span>}
            {adds.length > 0 && <div className="pc-plugin-tags"><span className="pc-settings-board__caption">Adds</span>{adds.map(text => <span key={text} className="pc-plugin-tag">{text}</span>)}</div>}
            {may.length > 0 && <div className="pc-plugin-tags"><span className="pc-settings-board__caption">May</span>{may.map(text => <span key={text} className="pc-plugin-tag pc-plugin-tag--outlined">{text}</span>)}</div>}
            {reports[plugin.id] && <p role="status">{reports[plugin.id]}</p>}
          </div>
          <div className="pc-plugin-card__actions"><span className="pc-plugin-inline"><span className="pc-settings-board__caption">{plugin.enabled ? "On" : "Off"}</span><Switch size="sm" aria-label={`Enable ${plugin.id}`} checked={plugin.enabled} disabled={plugin.state === "refused"} aria-disabled={busy || resource.loading || plugin.state === "refused"} onChange={event => void toggle(plugin,event.currentTarget)}/></span>
            {plugin.state === "refused" && <span className="pc-settings-board__caption">Fix the plugin's reported error before enabling.</span>}
            <div className="pc-plugin-inline">{page && <ButtonLink size="sm" href={hrefFor(routes.pluginSettings(plugin.id))}>Settings</ButtonLink>}<ActionMenu label={`More actions for ${plugin.id}`} items={[{label:"Run checks",onSelect:() => void doctor(plugin)},...(!plugin.bundled ? [{label:"Remove…",onSelect:() => void remove(plugin)}] : [])]}/></div>
          </div>
        </article>;
      })}
    </section>
    <section aria-labelledby="plugin-places" className="pc-plugin-places"><h2 id="plugin-places" className="pc-settings-board__label">Where plugins appear</h2><div className="pc-plugin-places__grid">{places.map(([name,note]) => <div key={name}><b>{name}</b><span className="pc-settings-board__caption">{note}</span></div>)}</div><span className="pc-settings-board__caption">pacer never checks licences. A paid plugin verifies its own licence and reports its status here.</span></section>
    <Feedback action={action}/>{dialogs.dialog}
  </div></Page></DensityContext.Provider>;
}
