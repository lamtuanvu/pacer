import { useEffect, useRef, useState } from "preact/hooks";
import type { PluginInfo, SurfaceKind } from "../../../../src/plugins/registry";
import { Switch } from "../../ds/Controls";
import { Icon } from "../../ds/icons";
import { Pill } from "../../ds/Pill";
import { useDialogs } from "../../ds/useDialogs";
import { Feedback, useOperation, useResource } from "./shared";

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
  const resource = useResource<{ plugins: PluginInfo[] }>("plugin.list");
  const action = useOperation(undefined, { notifySuccess: false });
  const dialogs = useDialogs();
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const restoreFocus = useRef<{ control: HTMLInputElement; data: typeof resource.data }>();
  useEffect(() => {
    const restore = restoreFocus.current;
    if (restore && resource.data !== restore.data && !resource.loading && !busy) {
      restoreFocus.current = undefined;
      if (restore.control.isConnected) restore.control.focus();
    }
  }, [resource.data, resource.loading, busy]);
  async function toggle(plugin: PluginInfo, control: HTMLInputElement) {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    restoreFocus.current = { control, data: resource.data };
    try {
      const result = await action.run(plugin.enabled ? "plugin.disable" : "plugin.enable", { id: plugin.id });
      const enabled = result?.data as EnableResult | undefined;
      if (enabled?.state === "needs_grant") {
        action.clear();
        const surfaces = (enabled.surfaces ?? []).map(kind => surfaceNames[kind][1]);
        if (await dialogs.confirm(`${plugin.id} asks for:\n${(enabled.needs ?? []).map(name => `• ${name}`).join("\n") || "No capabilities"}${surfaces.length ? `\nAdds: ${surfaces.join(", ")}.` : ""}\nIt runs as you, with your access, until plugin sandboxing lands. Grant and enable?`, "Enable plugin", "Grant and enable")) {
          await action.run("plugin.enable", { id: plugin.id, grant: true });
        }
      }
    } finally {
      resource.reload(); pending.current = false; setBusy(false);
    }
  }
  if (resource.error || !resource.data) return null;
  return <section className="pc-settings-plugins" aria-labelledby="plugins-h">
    <h2 id="plugins-h" className="pc-settings-board__label">Plugins</h2>
    {resource.data.plugins.length ? <div className="pc-settings-plugins__list">{resource.data.plugins.map(plugin => {
      const adds = additions(plugin);
      return <div className="pc-settings-plugin" key={plugin.id}>
        <span className="pc-settings-plugin__icon" aria-hidden="true"><Icon name="plugin" /></span>
        <div className="pc-settings-plugin__copy"><div className="pc-settings-plugin__name"><b>{plugin.id}</b><span className="pc-settings-board__caption">{plugin.version}</span></div>
          {adds && <span className="pc-settings-board__caption">{adds}</span>}
          {plugin.error && <span className="pc-settings-board__caption">{plugin.error}</span>}
        </div>
        <span>{plugin.bundled && <Pill tone="neutral">Built in</Pill>}</span>
        <Switch size="sm" aria-label={`Enable ${plugin.id}`} checked={plugin.enabled} disabled={busy || resource.loading || plugin.state === "refused"} onChange={event => void toggle(plugin, event.currentTarget)} />
      </div>;
    })}</div> : <p className="pc-settings-board__caption">No plugins installed.</p>}
    <span className="pc-settings-board__caption">A plugin can add a settings page, an activity-bar view, a side-panel tab, routing engines or usage readers. Each one is listed here with what it adds.</span>
    <Feedback action={action} />{dialogs.dialog}
  </section>;
}
