import { useContext, useState } from "preact/hooks";
import type { PluginInfo, SurfaceInfo, DoctorReport } from "../../../../src/plugins/registry";
import { Page, Skeleton } from "../../ds/Patterns";
import { DensityContext } from "../../ds/Density";
import { Switch } from "../../ds/Controls";
import { Pill } from "../../ds/Pill";
import { Icon } from "../../ds/icons";
import { ActionMenu } from "../../ds/ActionMenu";
import { PluginContext } from "../../plugins/catalog";
import { AppButtonLink } from "../../navigation";
import { routes } from "../../router";
import { ErrorMessage } from "../task-shared";
import { useResource, Feedback } from "./shared";
import { usePluginToggle } from "./Plugins";
import { pluginIcon, pluginAdditions, capabilityWords, attentionState, pluginPresentation } from "./plugin-presentation";
import { usePluginSettingsStyles } from "./plugin-styles";
const places = [["Settings pages", "Listed under Extend, marked “plugin”"], ["Activity bar", "Icons under Plugins on the left"], ["Side panels", "Sections on the left, tabs on the right"], ["Routing engines", "A choice method in Dispatcher"], ["Usage readers", "Budgets for more agents"]];
export function PluginsPage({ initialData, initialSurfaces }: { initialData?: {plugins:PluginInfo[]}; initialSurfaces?: {surfaces:SurfaceInfo[]} }) {
  usePluginSettingsStyles();
  const resource = useResource("plugin.list", {}, initialData), catalog = useContext(PluginContext), surfaces = catalog.surfaces.length ? catalog.surfaces : initialSurfaces?.surfaces ?? [];
  const {action, dialogs, busy, toggle} = usePluginToggle(resource.reload, resource.loading);
  const [reports, setReports] = useState<Record<string,string>>({});
  async function doctor(plugin: PluginInfo) {
    await action.run("plugin.doctor", {id:plugin.id}, (data: {reports:DoctorReport[]}) => {
      setReports(old => ({...old,[plugin.id]:data.reports.map(report => report.ok ? "Checks passed." : report.error ? `Checks found a problem: ${report.error}` : `Needs permission: ${report.needs ?? "Review plugin permissions."}`).join(" · ")})); resource.reload();
    });
  }
  async function remove(plugin: PluginInfo) {
    if (await dialogs.confirm(`Remove the plugin ${pluginPresentation(plugin).name}? Its settings will also be removed.`, "Remove plugin", "Remove")) await action.run("plugin.remove", {id:plugin.id}, resource.reload);
  }
  return <DensityContext.Provider value="settings"><Page width="full" className="u3-settings u3-settings-page"><div className="pc-settings-board pc-plugin-settings">
    <header className="pc-settings-board__header"><h1>Plugins</h1><p>Add capabilities to pacer. Each plugin runs in its own process and says exactly what it adds and what it may access.</p></header>
    <span id="plugins-installed-label" className="pc-settings-board__label">Installed · {resource.data?.plugins.length ?? "…"}</span>
    <section aria-labelledby="plugins-installed-label" className="pc-plugin-installed">
      {!resource.data && !resource.error && <Skeleton layout="settings" label="Loading plugins…"/>}<ErrorMessage error={resource.error}/>
      {resource.data?.plugins.length === 0 && <p>No plugins installed.</p>}
      {resource.data?.plugins.map(plugin => {
        const presentation = pluginPresentation(plugin), adds = pluginAdditions(plugin), may = capabilityWords(plugin), page = plugin.enabled && surfaces.some(s => s.plugin === plugin.id && s.surface === "settings" && s.visible);
        const status = plugin.state === "failing" ? {tone:"bad" as const,label:"Failing"} : plugin.state === "refused" ? {tone:"bad" as const,label:"Refused"} : plugin.state === "needs_grant" ? {tone:"warn" as const,label:"Needs permission"} : undefined;
        return <article key={plugin.id} className={`pc-plugin-card${plugin.state === "failing" || plugin.state === "refused" ? " pc-plugin-card--bad" : attentionState(plugin) ? " pc-plugin-card--attention" : ""}`} aria-label={presentation.name}>
          <span className="pc-plugin-card__icon" aria-hidden="true"><Icon name={pluginIcon(plugin.id,surfaces ?? [])}/></span>
          <div className="pc-plugin-card__copy"><div className="pc-plugin-card__name"><b>{presentation.name}</b><span className="pc-settings-board__caption">{[plugin.version, plugin.publisher].filter(Boolean).join(" · ")}</span>{plugin.bundled && <Pill tone="neutral">Built in</Pill>}{status && <Pill tone={status.tone}>{status.label}</Pill>}</div>
            {presentation.description && <p className="pc-plugin-card__description">{presentation.description}</p>}
            {plugin.error && <span className="pc-plugin-card__error">{plugin.error}</span>}
            {<div className="pc-plugin-tags"><span className="pc-settings-board__caption">Adds</span>{!adds.length && <span className="pc-plugin-tag">No additional views</span>}{adds.map(text => <span key={text} className="pc-plugin-tag">{text}</span>)}</div>}
            {<div className="pc-plugin-tags"><span className="pc-settings-board__caption">May</span>{!may.length && <span className="pc-plugin-tag pc-plugin-tag--outlined">No additional access</span>}{may.map(text => <span key={text} className="pc-plugin-tag pc-plugin-tag--outlined">{text}</span>)}</div>}
            {reports[plugin.id] && <p role="status">{reports[plugin.id]}</p>}
          </div>
          <div className="pc-plugin-card__actions"><span className="pc-plugin-inline"><span className="pc-settings-board__caption">{plugin.enabled ? "On" : "Off"}</span><Switch size="sm" aria-label={`Enable ${presentation.name}`} checked={plugin.enabled} disabled={plugin.state === "refused"} aria-disabled={busy || resource.loading || plugin.state === "refused"} onChange={event => void toggle(plugin,event.currentTarget)}/></span>
            {plugin.state === "refused" && <span className="pc-settings-board__caption">Fix the plugin's reported error before enabling.</span>}
            <div className="pc-plugin-inline">{page && <AppButtonLink className="pc-plugin-settings-link" to={routes.pluginSettings(plugin.id)}>Settings</AppButtonLink>}<ActionMenu label={`More actions for ${presentation.name}`} items={[{label:"Run checks",onSelect:() => void doctor(plugin)},...(!plugin.bundled ? [{label:"Remove…",onSelect:() => void remove(plugin)}] : [])]}/></div>
          </div>
        </article>;
      })}
    </section>
    <section aria-labelledby="plugin-places" className="pc-plugin-places"><h2 id="plugin-places" className="pc-settings-board__label">Where plugins appear</h2><div className="pc-plugin-places__grid">{places.map(([name,note]) => <div key={name}><b>{name}</b><span className="pc-settings-board__caption">{note}</span></div>)}</div><span className="pc-settings-board__caption">pacer never checks licences. A paid plugin verifies its own licence and reports its status here.</span></section>
    <Feedback action={action}/>{dialogs.dialog}
  </div></Page></DensityContext.Provider>;
}
