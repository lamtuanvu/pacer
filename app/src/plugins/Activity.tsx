import { useContext, useEffect, useRef, useState } from "preact/hooks";
import type { ViewDocument as PluginDocument } from "../../../src/plugins/ui-schema";
import type { PluginInfo } from "../../../src/plugins/registry";
import { useTaskContext } from "../screens/task-shared";
import { PluginContext } from "./catalog";
import { ViewDocument, type ViewAction } from "./ViewDocument";
import { useDialogs } from "../ds/useDialogs";
import { Page, Stack, LoadingState, EmptyState } from "../ds/Patterns";
import { Button } from "../ds/Button";
import { AppLink } from "../navigation";
import { routes, titleFor } from "../router";
import styles from "./plugins.css" with { type: "text" };

export function pluginError(error: unknown) {
  const code = (error as { code?: string })?.code;
  return code === "plugin_unavailable" ? { title: "This plugin is turned off or needs attention.", settings: true }
    : code === "plugin_timeout" ? { title: "This plugin didn't answer in time.", retry: true }
    : code === "invalid_input" ? { title: "This plugin's view couldn't be shown." }
    : code === "unknown_plugin" || code === "not_found" ? { title: "This plugin view no longer exists." }
    : { title: "Couldn't load this plugin view.", retry: true };
}
export function PluginError({ error, retry }: { error: unknown; retry: () => void }) {
  const state = pluginError(error);
  return <EmptyState title={state.title}>{state.settings && <AppLink to={routes.settings("plugins")}>Open Plugins settings</AppLink>}{state.retry && <Button onClick={retry}>Retry</Button>}</EmptyState>;
}
export async function confirmPluginAction(plugin: string, action: ViewAction, confirm: (message: string, title: string, label: string) => Promise<boolean>) {
  if (!action.confirm && action.variant !== "danger") return true;
  return confirm(action.confirm ? `“${action.confirm.body}”` : `“${action.label}”`, action.confirm ? `${plugin} asks: ${action.confirm.title}` : `${plugin} asks to ${action.label}`, "Continue");
}
function currentTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  const choice = window.document.documentElement.dataset.theme;
  return choice === "dark" || (!choice && window.matchMedia?.("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
}
const styled = new WeakSet<Document>();
export function Activity({ plugin, id }: { plugin: string; id: string }) {
  const { api } = useTaskContext(), { revision, surfaces } = useContext(PluginContext), dialogs = useDialogs();
  const [info, setInfo] = useState<PluginInfo>(), [document, setDocument] = useState<PluginDocument>(), [error, setError] = useState<unknown>(), [stale, setStale] = useState(false);
  const [attempt, reload] = useState(0), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  // The host allows two renders a second per surface; one quiet retry covers a refresh racing an invalidation.
  const pending = useRef(false), active = useRef(true), retried = useRef(false);
  const [infoError, setInfoError] = useState(false), [busyControl, setBusyControl] = useState<string>();
  const focusControl = useRef<string>();
  const title = surfaces.find(s => s.plugin === plugin && s.id === id && s.surface === "activity")?.title ?? "Plugin view";
  useEffect(() => { const previous = window.document.title; const next = titleFor({name:"plugin",plugin,id,query:{repo:null,scope:null}},title); window.document.title = next; return () => {if(window.document.title === next) window.document.title = previous;}; }, [title,plugin,id]);
  const [theme, setTheme] = useState<"light" | "dark">(currentTheme);
  useEffect(() => {
    if (!styled.has(window.document)) { const sheet = new CSSStyleSheet(); sheet.replaceSync(styles); window.document.adoptedStyleSheets = [...window.document.adoptedStyleSheets, sheet]; styled.add(window.document); }
    const media = matchMedia("(prefers-color-scheme: dark)");
    const update = () => setTheme(currentTheme());
    const observer = new MutationObserver(update); observer.observe(window.document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    media.addEventListener("change", update); update();
    return () => { active.current = false; observer.disconnect(); media.removeEventListener("change", update); };
  }, []);
  const context = { route: "start", theme } as const;
  useEffect(() => {
    let alive = true;
    void api.call<{ plugins: PluginInfo[] }>("plugin.list", {}).then(data => { if (alive) {setInfo(data.plugins.find(p => p.id === plugin));setInfoError(false);} }, () => {if(alive) setInfoError(true);});
    return () => { alive = false; };
  }, [api, plugin, revision]);
  useEffect(() => {
    let alive = true; setError(undefined);
    void api.call<{ document: PluginDocument; stale?: boolean }>("plugin.ui.render", { plugin, surface: "activity", id, context }).then(data => { if (alive) { retried.current = false; setDocument(data.document); setStale(!!data.stale); if(focusControl.current) { const control = focusControl.current; requestAnimationFrame(() => { const controls = window.document.querySelectorAll<HTMLElement>("[data-plugin-control]"); Array.from(controls).find(node => node.dataset.pluginControl === control)?.focus(); }); focusControl.current = undefined; } } }, error => { if (!alive) return; if ((error as { code?: string })?.code === "conflict" && !retried.current) { retried.current = true; setTimeout(() => { if (alive) reload(n => n + 1); }, 1100); return; } setError(error); setStale(true); });
    return () => { alive = false; };
  }, [api, plugin, id, revision, attempt, theme]);
  async function action(value: ViewAction, control?: string) {
    if (pending.current || stale || error) return;
    pending.current = true;
    try {
      if (!await confirmPluginAction(plugin, value, dialogs.confirm) || !active.current) return;
      setBusy(true); setBusyControl(control); setMessage("");
      const result = await api.call<{ result: "done" | "refresh"; message?: string }>("plugin.ui.action", { plugin, surface: "activity", id, action: value.action, context, requestId: crypto.randomUUID(), ...(value.values ? { values: value.values } : {}) });
      if (!active.current) return;
      setMessage(result.message ? `${plugin}: ${result.message}` : "Action completed.");
      if (result.result === "refresh") { focusControl.current = control; reload(n => n + 1); }
    } catch { if (active.current) setMessage("Couldn't complete this plugin action. Try again."); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  return <Page width="standard"><Stack>
    <header className="pc-settings-board__header pc-plugin-header"><h1>{title} <span className="pc-plugin-marker">plugin</span></h1></header>
    <p className="pc-plugin-muted">Added by the plugin {plugin}{info?.version ? ` ${info.version}` : ""}{info?.publisher ? ` from ${info.publisher}` : ""}</p>
    {infoError && <p role="status">Plugin details could not be refreshed.</p>}
    {document && stale && <p role="status">This view is out of date. Retry to use its actions. {(!error || !pluginError(error).retry) && <Button onClick={() => reload(n => n + 1)}>Retry</Button>}</p>}
    {error && <PluginError error={error} retry={() => reload(n => n + 1)} />}
    {document ? <ViewDocument document={document} onAction={(value,control) => void action(value,control)} busy={busy} busyControl={busyControl} disabled={stale || !!error} /> : !error && <LoadingState label="Loading plugin view…" />}
    {message && <p role="status">{message}</p>}{dialogs.dialog}
  </Stack></Page>;
}
