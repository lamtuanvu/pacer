import { ImmediateSave } from "../../ds/ImmediateSave";
import { useRef, useState } from "preact/hooks";
import type { PluginInfo, SurfaceKind } from "../../../../src/plugins/registry";
import { AppLink } from "../../navigation";
import { routes } from "../../router";
import { Switch } from "../../ds/Controls";
import { Icon } from "../../ds/icons";
import { Pill } from "../../ds/Pill";
import { useDialogs } from "../../ds/useDialogs";
import { useTaskContext, ErrorMessage } from "../task-shared";
import { Feedback, useOperation, useResource } from "./shared";

import { pluginPresentation, pluginIcon } from "./plugin-presentation";
import { usePluginSettingsStyles } from "./plugin-styles";

type EnableResult = { state: string; needs?: string[]; surfaces?: SurfaceKind[] };
const surfaceNames: Record<SurfaceKind, [string, string]> = {
  settings: ["a settings page", "settings pages"], activity: ["an activity-bar view", "activity-bar views"],
  panelTabs: ["a side-panel tab", "side-panel tabs"], status: ["a status-bar item", "status-bar items"],
};
const contributionNames: Record<string, string> = {
  diagnostic: "diagnostic checks", agentSession: "live agent sessions", observation: "usage readers", decision: "routing engines",
};
function additions(plugin: PluginInfo): string | null {
  const parts = Object.entries(surfaceNames).flatMap(([kind, names]) => {
    const count = plugin.ui[kind as SurfaceKind];
    return count ? [count === 1 ? names[0] : `${count} ${names[1]}`] : [];
  });
  for (const point of plugin.contributes) if (contributionNames[point]) parts.push(contributionNames[point]);
  return parts.length ? `Adds ${parts.join(", ")}.` : null;
}

/** Optional service capability; only the lazy settings chunk loads this editor. */
export function PluginsSection() {
  usePluginSettingsStyles();
  const resource = useResource<{ plugins: PluginInfo[] }>("plugin.list");
  const { action, dialogs, busy, toggle } = usePluginToggle(resource.reload, resource.loading);
  if (!resource.data) return null;
  return <section className="pc-settings-plugins" aria-labelledby="plugins-h">
    <div className="u3-row"><h2 id="plugins-h" className="pc-settings-board__label">Plugins</h2><AppLink to={routes.settings("plugins")} className="pc-plugin-manage">Manage in Plugins</AppLink></div>
    {resource.data.plugins.length ? <ul className="pc-settings-plugins__list" aria-label="Plugins" role="list">{resource.data.plugins.map(plugin => {
      const adds = additions(plugin), presentation = pluginPresentation(plugin);
      const errorId = `plugin-${plugin.id}-error`;
      return <li className="pc-settings-plugin" key={plugin.id}>
        <span className="pc-settings-plugin__icon" aria-hidden="true"><Icon name={pluginIcon(plugin.id, [])} /></span>
        <div className="pc-settings-plugin__copy"><div className="pc-settings-plugin__name"><b>{presentation.name}</b><span className="pc-settings-board__caption">{[plugin.version, plugin.publisher].filter(Boolean).join(" · ")}</span></div>
          {presentation.description && <span className="pc-settings-board__caption">{presentation.description}</span>}
          {adds && !presentation.description && <span className="pc-settings-board__caption">{adds}</span>}
          {plugin.error && <span id={errorId} className="pc-settings-board__caption">{plugin.error}</span>}
        </div>
        <span>{plugin.bundled && <Pill tone="neutral">Built in</Pill>}</span>
        <ImmediateSave value={plugin.enabled} save={() => toggle(plugin)}>{(value, change, saving) => <Switch size="sm" aria-label={`Enable ${presentation.name}`} aria-describedby={plugin.error ? errorId : undefined} checked={value} disabled={saving || busy || resource.loading || plugin.state === "refused"} onChange={event => change(event.currentTarget.checked)} />}</ImmediateSave>
      </li>;
    })}</ul> : <p className="pc-settings-board__caption">No plugins installed.</p>}
    <span className="pc-settings-board__caption">A plugin can add a settings page, an activity-bar view, a side-panel tab, routing engines or usage readers. Each one is listed here with what it adds.</span>
    <ErrorMessage error={resource.error} />
    <Feedback action={action} />{dialogs.dialog}
  </section>;
}

/** Shared enable flow, including the explicit capability and surface grant. */
export function usePluginToggle(reload: () => void, loading = false) {
  const action = useOperation(undefined, { notifySuccess: false });
  const {api} = useTaskContext();
  const dialogs = useDialogs();
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  async function toggle(plugin: PluginInfo, control?: HTMLInputElement) {
    if (pending.current || loading || plugin.state === "refused") {
      if (control) control.checked = plugin.enabled;
      return;
    }
    pending.current = true; setBusy(true);
    try {
      const enabled = await api.call<EnableResult>(plugin.enabled ? "plugin.disable" : "plugin.enable", { id: plugin.id });
      if (enabled?.state === "needs_grant") {
        action.clear();
        const surfaces = (enabled.surfaces ?? []).map(kind => surfaceNames[kind][1]);
        if (await dialogs.confirm(`${pluginPresentation(plugin).name} asks for:\n${(enabled.needs ?? []).map(name => `• ${name}`).join("\n") || "No capabilities"}${surfaces.length ? `\nAdds: ${surfaces.join(", ")}.` : ""}\nIt runs as you, with your access, until plugin sandboxing lands. Grant and enable?`, "Enable plugin", "Grant and enable")) {
          await api.call("plugin.enable", { id: plugin.id, grant: true });
        } else return false;
      }
    } finally {
      reload(); pending.current = false; setBusy(false);
    }
  }
  return { action, dialogs, busy, toggle };
}
